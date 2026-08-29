/**
 * Transport service (Phase 18).
 *
 * The rules this file keeps, in the order they matter:
 *
 *  1. **One ACTIVE vehicle per route and one ACTIVE assignment per student are database
 *     properties.** The service checks under a row lock (`for update`) so the common case
 *     gets a friendly 409, but the actual guarantees are the partial unique indexes
 *     `route_vehicles_route_active_key` and `student_transport_student_active_key` — two
 *     concurrent writes collide in Postgres, and the exceptions filter surfaces that as a
 *     409 too.
 *  2. **Route capacity is enforced at assignment time, under the route's row lock.** The
 *     count of active assignments is taken as a fact inside the same transaction, so two
 *     clerks filling the last seat serialize on the lock instead of both succeeding.
 *  3. **No floating-point money.** A stop's fare, a fee override and a maintenance cost are
 *     `numeric(14, 2)`, parsed only by `Money.fromDecimalString` and written only by
 *     `Money.toDecimalString` (ADR-004). Coordinates are `numeric(9, 6)` strings end to end.
 *  4. **Nothing is deleted.** Vehicles retire, drivers deactivate, assignments end with a
 *     date, and a stop removed from a route's set is archived with a reason — never deleted,
 *     because assignment history still points at it.
 *  5. **Expiries produce a report, not an action.** `expiringDocuments` lists lapsed and
 *     soon-to-lapse insurance, fitness and licence dates; nothing here suspends a vehicle or
 *     a driver automatically. A human reads the report and acts, auditable like any action.
 *  6. **Self-service reads are scoped by identity, not by input.** `myChildTransport`
 *     derives the student set from the principal's own student or guardian links, and
 *     `livePosition` refuses — with a 404, never a 403 — a route the caller's child is not
 *     actively assigned to. There is no parameter through which a guardian can name another
 *     family's child.
 *
 * ── Integration with the fees module ─────────────────────────────────────────────────
 *
 * Transport deliberately writes into **no** fee table. The integration surface is
 * `faresForBillingPeriod(tx, institutionId, periodStart, periodEnd)`: the fees module calls
 * it inside its own invoice-generation transaction and receives one row per student actively
 * assigned during the period, with the monthly fare already resolved as
 * `coalesce(fee_override, stop.fare)` — a decimal string ready for `Money`. What the fees
 * module does with those figures (a `transport` fee head, an invoice line) is its decision,
 * made in its transaction, under its audit trail. The HTTP fee-schedule endpoint is a
 * read-only view over the same method.
 */

import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import {
  campuses,
  drivers,
  employees,
  routeStops,
  routeVehicles,
  shifts,
  studentGuardians,
  students,
  studentTransport,
  transportRoutes,
  tripAttendance,
  vehicleMaintenance,
  vehicles,
  vehicleTrips,
} from '@shikkha/db';
import {
  addDays,
  addMonths,
  buildOffsetPage,
  calendarDate,
  compareCalendarDates,
  ConflictError,
  daysBetween,
  ForbiddenError,
  Money,
  NotFoundError,
  offsetOf,
  parseSort,
  todayInDhaka,
  uuidv7,
  ValidationError,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { can, type Permission, type Principal } from '@shikkha/permissions';
import {
  TRANSPORT_ASSIGNMENT_SORT_FIELDS,
  TRANSPORT_DRIVER_SORT_FIELDS,
  TRANSPORT_ROUTE_SORT_FIELDS,
  TRANSPORT_TRIP_SORT_FIELDS,
  TRANSPORT_VEHICLE_SORT_FIELDS,
  type AssignStudentTransportInput,
  type AssignTransportVehicleInput,
  type BulkAssignStudentTransportInput,
  type CreateTransportDriverInput,
  type CreateTransportRouteInput,
  type CreateTransportVehicleInput,
  type CreateVehicleMaintenanceInput,
  type EndStudentTransportInput,
  type EndTransportVehicleAssignmentInput,
  type EndVehicleTripInput,
  type MarkTripAttendanceInput,
  type PutTransportRouteStopsInput,
  type StartVehicleTripInput,
} from '@shikkha/validation';
import { DatabaseService } from '../database/database.service';
import { GpsProviderRegistry } from './providers/gps-provider.registry';

/** The transaction handle `runInTenant` hands to its callback. */
export type Tx = Parameters<Parameters<DatabaseService['runInTenant']>[0]>[0];

type VehicleRow = typeof vehicles.$inferSelect;
type DriverRow = typeof drivers.$inferSelect;
type RouteRow = typeof transportRoutes.$inferSelect;
type StopRow = typeof routeStops.$inferSelect;
type RouteVehicleRow = typeof routeVehicles.$inferSelect;
type StudentTransportRow = typeof studentTransport.$inferSelect;
type TripRow = typeof vehicleTrips.$inferSelect;
type MaintenanceRow = typeof vehicleMaintenance.$inferSelect;

export interface ListQueryBase {
  page: number;
  pageSize: number;
  sort?: string;
  includeArchived: boolean;
}

export interface ListVehiclesQuery extends ListQueryBase {
  q?: string;
  status?: string;
}

export interface ListDriversQuery extends ListQueryBase {
  q?: string;
  status?: string;
}

export interface ListRoutesQuery extends ListQueryBase {
  q?: string;
  campusId?: string;
  status?: string;
}

export interface ListAssignmentsQuery extends ListQueryBase {
  routeId?: string;
  stopId?: string;
  studentId?: string;
  status?: string;
}

export interface ListTripsQuery extends ListQueryBase {
  routeId?: string;
  tripDate?: string;
  direction?: string;
}

export interface ListMaintenanceQuery extends ListQueryBase {
  vehicleId?: string;
}

/** One row of the fee-module integration surface. Money is a decimal string, always. */
export interface TransportFareRow {
  studentId: string;
  routeId: string;
  routeCode: string;
  stopId: string;
  stopName: string;
  direction: StudentTransportRow['direction'];
  /** `coalesce(fee_override, stop.fare)`, as a decimal string for `Money`. */
  monthlyFare: string;
}

@Injectable()
export class TransportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly gps: GpsProviderRegistry,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════════════
  // Vehicles
  // ══════════════════════════════════════════════════════════════════════════════════

  async listVehicles(
    principal: Principal,
    institutionId: string,
    query: ListVehiclesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<VehicleRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(vehicles.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        vehicles.archivedAt,
        query.includeArchived,
        'transport.vehicles.manage',
      );
      if (query.status) {
        filters.push(eq(vehicles.status, query.status as VehicleRow['status']));
      }
      if (query.q) {
        filters.push(
          or(
            ilike(vehicles.registrationNumber, `%${query.q}%`),
            ilike(vehicles.model, `%${query.q}%`),
          )!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, TRANSPORT_VEHICLE_SORT_FIELDS, {
        field: 'registrationNumber',
        direction: 'asc',
      }).map((spec) => {
        const column = VEHICLE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(vehicles)
        .where(where)
        .orderBy(...orderBy, asc(vehicles.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(vehicles)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createVehicle(
    principal: Principal,
    institutionId: string,
    input: CreateTransportVehicleInput,
  ): Promise<VehicleRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select({ id: vehicles.id })
        .from(vehicles)
        .where(
          and(
            eq(vehicles.institutionId, institutionId),
            eq(vehicles.registrationNumber, input.registrationNumber),
            isNull(vehicles.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError('A vehicle with this registration number already exists.', {
          existingVehicleId: existing.id,
        });
      }

      const [created] = await tx
        .insert(vehicles)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          registrationNumber: input.registrationNumber,
          model: input.model ?? null,
          capacity: input.capacity,
          fuelType: input.fuelType,
          insuranceExpiry: input.insuranceExpiry ?? null,
          fitnessExpiry: input.fitnessExpiry ?? null,
          status: 'active',
          notes: input.notes ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  /** One vehicle with its maintenance history and current route assignment. */
  async getVehicle(institutionId: string, id: string) {
    return this.db.runInTenant(async (tx) => {
      const vehicle = await this.loadVehicle(tx, institutionId, id);

      const maintenance = await tx
        .select()
        .from(vehicleMaintenance)
        .where(and(eq(vehicleMaintenance.vehicleId, id), isNull(vehicleMaintenance.archivedAt)))
        .orderBy(desc(vehicleMaintenance.performedOn));

      const [assignment] = await tx
        .select({
          assignment: routeVehicles,
          routeCode: transportRoutes.code,
          routeName: transportRoutes.nameEn,
        })
        .from(routeVehicles)
        .innerJoin(transportRoutes, eq(transportRoutes.id, routeVehicles.routeId))
        .where(
          and(
            eq(routeVehicles.vehicleId, id),
            eq(routeVehicles.status, 'active'),
            isNull(routeVehicles.archivedAt),
          ),
        )
        .limit(1);

      return {
        ...vehicle,
        maintenance,
        activeAssignment: assignment
          ? { ...assignment.assignment, routeCode: assignment.routeCode, routeName: assignment.routeName }
          : null,
      };
    });
  }

  async updateVehicle(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ vehicle: VehicleRow; previous: Partial<VehicleRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadVehicle(tx, institutionId, id);

      const [updated] = await tx
        .update(vehicles)
        .set({
          ...(changes as Partial<VehicleRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(vehicles.id, id), eq(vehicles.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This vehicle was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { vehicle: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  /** Retirement, never deletion: the trip and maintenance history stays. */
  async archiveVehicle(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<VehicleRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadVehicle(tx, institutionId, id);

      const [liveAssignment] = await tx
        .select({ id: routeVehicles.id })
        .from(routeVehicles)
        .where(
          and(
            eq(routeVehicles.vehicleId, id),
            eq(routeVehicles.status, 'active'),
            isNull(routeVehicles.archivedAt),
          ),
        )
        .limit(1);
      if (liveAssignment) {
        throw new ConflictError(
          'This vehicle is still assigned to a route. End that assignment first.',
        );
      }

      const [archived] = await tx
        .update(vehicles)
        .set({
          status: 'retired',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(vehicles.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Maintenance
  // ══════════════════════════════════════════════════════════════════════════════════

  async listMaintenance(
    principal: Principal,
    institutionId: string,
    query: ListMaintenanceQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<MaintenanceRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(vehicleMaintenance.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        vehicleMaintenance.archivedAt,
        query.includeArchived,
        'transport.vehicles.manage',
      );
      if (query.vehicleId) filters.push(eq(vehicleMaintenance.vehicleId, query.vehicleId));

      const where = and(...filters);

      const rows = await tx
        .select()
        .from(vehicleMaintenance)
        .where(where)
        .orderBy(desc(vehicleMaintenance.performedOn), asc(vehicleMaintenance.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(vehicleMaintenance)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createMaintenance(
    principal: Principal,
    institutionId: string,
    input: CreateVehicleMaintenanceInput,
  ): Promise<MaintenanceRow> {
    return this.db.runInTenant(async (tx) => {
      await this.loadVehicle(tx, institutionId, input.vehicleId);

      const [created] = await tx
        .insert(vehicleMaintenance)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          vehicleId: input.vehicleId,
          kind: input.kind,
          performedOn: input.performedOn,
          odometer: input.odometer ?? null,
          cost: Money.fromDecimalString(input.cost).toDecimalString(),
          vendor: input.vendor ?? null,
          notes: input.notes ?? null,
          nextDueOn: input.nextDueOn ?? null,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Drivers
  // ══════════════════════════════════════════════════════════════════════════════════

  async listDrivers(
    principal: Principal,
    institutionId: string,
    query: ListDriversQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<DriverRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(drivers.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        drivers.archivedAt,
        query.includeArchived,
        'transport.vehicles.manage',
      );
      if (query.status) filters.push(eq(drivers.status, query.status as DriverRow['status']));
      if (query.q) {
        filters.push(
          or(
            ilike(drivers.fullNameEn, `%${query.q}%`),
            ilike(drivers.licenceNumber, `${query.q}%`),
          )!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, TRANSPORT_DRIVER_SORT_FIELDS, {
        field: 'fullNameEn',
        direction: 'asc',
      }).map((spec) => {
        const column = DRIVER_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(drivers)
        .where(where)
        .orderBy(...orderBy, asc(drivers.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(drivers)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createDriver(
    principal: Principal,
    institutionId: string,
    input: CreateTransportDriverInput,
  ): Promise<DriverRow> {
    return this.db.runInTenant(async (tx) => {
      if (input.employeeId) {
        const [employee] = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(
              eq(employees.id, input.employeeId),
              eq(employees.institutionId, institutionId),
              isNull(employees.archivedAt),
            ),
          )
          .limit(1);
        if (!employee) throw new NotFoundError('Employee', input.employeeId);

        const [linked] = await tx
          .select({ id: drivers.id })
          .from(drivers)
          .where(and(eq(drivers.employeeId, input.employeeId), isNull(drivers.archivedAt)))
          .limit(1);
        if (linked) {
          throw new ConflictError('This employee already has a driver record.', {
            existingDriverId: linked.id,
          });
        }
      }

      const [created] = await tx
        .insert(drivers)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          employeeId: input.employeeId ?? null,
          fullNameEn: input.fullNameEn,
          fullNameBn: input.fullNameBn ?? null,
          phone: input.phone,
          licenceNumber: input.licenceNumber,
          licenceExpiry: input.licenceExpiry,
          status: 'active',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async updateDriver(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ driver: DriverRow; previous: Partial<DriverRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadDriver(tx, institutionId, id);

      const [updated] = await tx
        .update(drivers)
        .set({
          ...(changes as Partial<DriverRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(drivers.id, id), eq(drivers.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This driver was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { driver: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveDriver(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<DriverRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadDriver(tx, institutionId, id);

      const [liveAssignment] = await tx
        .select({ id: routeVehicles.id })
        .from(routeVehicles)
        .where(
          and(
            eq(routeVehicles.driverId, id),
            eq(routeVehicles.status, 'active'),
            isNull(routeVehicles.archivedAt),
          ),
        )
        .limit(1);
      if (liveAssignment) {
        throw new ConflictError(
          'This driver is still assigned to a route. End that assignment first.',
        );
      }

      const [archived] = await tx
        .update(drivers)
        .set({
          status: 'inactive',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(drivers.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Routes
  // ══════════════════════════════════════════════════════════════════════════════════

  async listRoutes(
    principal: Principal,
    institutionId: string,
    query: ListRoutesQuery,
    page: OffsetPageRequest,
  ): Promise<OffsetPage<RouteRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(transportRoutes.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        transportRoutes.archivedAt,
        query.includeArchived,
        'transport.routes.manage',
      );
      if (query.campusId) filters.push(eq(transportRoutes.campusId, query.campusId));
      if (query.status) filters.push(eq(transportRoutes.status, query.status));
      if (query.q) {
        filters.push(
          or(
            ilike(transportRoutes.code, `${query.q}%`),
            ilike(transportRoutes.nameEn, `%${query.q}%`),
          )!,
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, TRANSPORT_ROUTE_SORT_FIELDS, {
        field: 'code',
        direction: 'asc',
      }).map((spec) => {
        const column = ROUTE_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select()
        .from(transportRoutes)
        .where(where)
        .orderBy(...orderBy, asc(transportRoutes.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(transportRoutes)
        .where(where);

      return buildOffsetPage(rows, counted?.total ?? 0, page);
    });
  }

  async createRoute(
    principal: Principal,
    institutionId: string,
    input: CreateTransportRouteInput,
  ): Promise<RouteRow> {
    return this.db.runInTenant(async (tx) => {
      await this.assertCampus(tx, institutionId, input.campusId);
      if (input.shiftId) await this.assertShift(tx, institutionId, input.shiftId);

      const [existing] = await tx
        .select({ id: transportRoutes.id })
        .from(transportRoutes)
        .where(
          and(
            eq(transportRoutes.institutionId, institutionId),
            eq(transportRoutes.code, input.code),
            isNull(transportRoutes.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError('A route with this code already exists.', {
          existingRouteId: existing.id,
        });
      }

      const [created] = await tx
        .insert(transportRoutes)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          campusId: input.campusId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          shiftId: input.shiftId ?? null,
          distanceKm: input.distanceKm ?? null,
          status: 'active',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  /** One route with its live stops, active vehicle assignment and student count. */
  async getRoute(institutionId: string, id: string) {
    return this.db.runInTenant(async (tx) => {
      const route = await this.loadRoute(tx, institutionId, id);

      const stops = await tx
        .select()
        .from(routeStops)
        .where(and(eq(routeStops.routeId, id), isNull(routeStops.archivedAt)))
        .orderBy(asc(routeStops.sequence));

      const activeVehicle = await this.activeVehicleAssignment(tx, id);

      const [assignedCount] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(studentTransport)
        .where(
          and(
            eq(studentTransport.routeId, id),
            eq(studentTransport.status, 'active'),
            isNull(studentTransport.archivedAt),
          ),
        );

      return {
        ...route,
        stops,
        activeVehicle,
        activeStudentCount: assignedCount?.total ?? 0,
      };
    });
  }

  async updateRoute(
    principal: Principal,
    institutionId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<{ route: RouteRow; previous: Partial<RouteRow> }> {
    const version = input['version'] as number;
    const { version: _ignored, ...changes } = input;

    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadRoute(tx, institutionId, id);

      const campusId = changes['campusId'] as string | undefined;
      if (campusId) await this.assertCampus(tx, institutionId, campusId);
      const shiftId = changes['shiftId'] as string | null | undefined;
      if (shiftId) await this.assertShift(tx, institutionId, shiftId);

      const [updated] = await tx
        .update(transportRoutes)
        .set({
          ...(changes as Partial<RouteRow>),
          version: existing.version + 1,
          updatedBy: principal.userId,
        })
        .where(and(eq(transportRoutes.id, id), eq(transportRoutes.version, version)))
        .returning();

      if (!updated) {
        throw new ConflictError(
          'This route was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: version, currentVersion: existing.version },
        );
      }

      return { route: updated, previous: diffOf(existing, updated, Object.keys(changes)) };
    });
  }

  async archiveRoute(
    principal: Principal,
    institutionId: string,
    id: string,
    reason: string,
  ): Promise<RouteRow> {
    return this.db.runInTenant(async (tx) => {
      const existing = await this.loadRoute(tx, institutionId, id);

      const [liveStudent] = await tx
        .select({ id: studentTransport.id })
        .from(studentTransport)
        .where(
          and(
            eq(studentTransport.routeId, id),
            eq(studentTransport.status, 'active'),
            isNull(studentTransport.archivedAt),
          ),
        )
        .limit(1);
      if (liveStudent) {
        throw new ConflictError(
          'Students are still actively assigned to this route. End their assignments first.',
        );
      }

      const [liveVehicle] = await tx
        .select({ id: routeVehicles.id })
        .from(routeVehicles)
        .where(
          and(
            eq(routeVehicles.routeId, id),
            eq(routeVehicles.status, 'active'),
            isNull(routeVehicles.archivedAt),
          ),
        )
        .limit(1);
      if (liveVehicle) {
        throw new ConflictError(
          'A vehicle is still assigned to this route. End that assignment first.',
        );
      }

      const [archived] = await tx
        .update(transportRoutes)
        .set({
          status: 'inactive',
          archivedAt: new Date(),
          archivedBy: principal.userId,
          archiveReason: reason,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(transportRoutes.id, id))
        .returning();
      return archived!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Stops: replaced as a set
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Replace a route's stop set whole.
   *
   * The submitted array order *is* the sequence, so the result is contiguous from 1 by
   * construction. Items carrying an `id` update the existing stop (assignments pointing at
   * it survive); items without one are created; live stops missing from the set are archived
   * — refused while an active student assignment still boards there, because ending those is
   * its own accountable action.
   *
   * Resequencing happens in two phases (shift every kept stop out of the final range, then
   * apply the final sequence) because the partial unique index on `(route_id, sequence)` is
   * not deferrable and a swap would otherwise collide mid-update.
   */
  async replaceStops(
    principal: Principal,
    institutionId: string,
    routeId: string,
    input: PutTransportRouteStopsInput,
  ): Promise<StopRow[]> {
    return this.db.runInTenant(async (tx) => {
      // Lock the route so two concurrent replacements serialize instead of interleaving.
      const [route] = await tx
        .select()
        .from(transportRoutes)
        .where(
          and(
            eq(transportRoutes.id, routeId),
            eq(transportRoutes.institutionId, institutionId),
            isNull(transportRoutes.archivedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (!route) throw new NotFoundError('Transport route', routeId);

      const liveStops = await tx
        .select()
        .from(routeStops)
        .where(and(eq(routeStops.routeId, routeId), isNull(routeStops.archivedAt)));
      const liveById = new Map(liveStops.map((stop) => [stop.id, stop]));

      for (const item of input.stops) {
        if (item.id && !liveById.has(item.id)) {
          throw new ValidationError('An id in the stop set does not name a stop of this route', [
            { path: 'stops', message: `Stop ${item.id} does not exist on this route` },
          ]);
        }
      }

      // Stops removed from the set are archived — never deleted — and only when no student
      // is actively assigned to board there.
      const keptIds = new Set(input.stops.map((item) => item.id).filter(Boolean) as string[]);
      const removed = liveStops.filter((stop) => !keptIds.has(stop.id));
      for (const stop of removed) {
        const [liveAssignment] = await tx
          .select({ id: studentTransport.id })
          .from(studentTransport)
          .where(
            and(
              eq(studentTransport.stopId, stop.id),
              eq(studentTransport.status, 'active'),
              isNull(studentTransport.archivedAt),
            ),
          )
          .limit(1);
        if (liveAssignment) {
          throw new ConflictError(
            `Students are still assigned to the stop "${stop.nameEn}". End or move their assignments before removing it.`,
          );
        }
        await tx
          .update(routeStops)
          .set({
            archivedAt: new Date(),
            archivedBy: principal.userId,
            archiveReason: 'Removed by stop-set replacement',
            updatedBy: principal.userId,
            version: stop.version + 1,
          })
          .where(eq(routeStops.id, stop.id));
      }

      // Phase 1: move every kept stop clear of the final 1..N range.
      if (keptIds.size > 0) {
        await tx
          .update(routeStops)
          .set({ sequence: sql`${routeStops.sequence} + 500` })
          .where(
            and(
              eq(routeStops.routeId, routeId),
              isNull(routeStops.archivedAt),
              inArray(routeStops.id, [...keptIds]),
            ),
          );
      }

      // Phase 2: apply the submitted order as the sequence.
      const result: StopRow[] = [];
      for (const [index, item] of input.stops.entries()) {
        const sequence = index + 1;
        const fare = Money.fromDecimalString(item.fare).toDecimalString();

        if (item.id) {
          const existing = liveById.get(item.id)!;
          const [updated] = await tx
            .update(routeStops)
            .set({
              sequence,
              nameEn: item.nameEn,
              nameBn: item.nameBn ?? null,
              latitude: item.latitude ?? null,
              longitude: item.longitude ?? null,
              pickupTime: item.pickupTime ?? null,
              dropTime: item.dropTime ?? null,
              fare,
              updatedBy: principal.userId,
              version: existing.version + 1,
            })
            .where(eq(routeStops.id, item.id))
            .returning();
          result.push(updated!);
        } else {
          const [created] = await tx
            .insert(routeStops)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              routeId,
              sequence,
              nameEn: item.nameEn,
              nameBn: item.nameBn ?? null,
              latitude: item.latitude ?? null,
              longitude: item.longitude ?? null,
              pickupTime: item.pickupTime ?? null,
              dropTime: item.dropTime ?? null,
              fare,
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning();
          result.push(created!);
        }
      }

      return result;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Vehicle assignment
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Put a vehicle and driver on a route. Any current active assignment is ended in the same
   * transaction, so the partial unique index `route_vehicles_route_active_key` — the real
   * guarantee — is never even approached by the ordinary path. A concurrent double-assign
   * collides on it in Postgres and surfaces as a 409.
   */
  async assignVehicle(
    principal: Principal,
    institutionId: string,
    routeId: string,
    input: AssignTransportVehicleInput,
  ) {
    return this.db.runInTenant(async (tx) => {
      const [route] = await tx
        .select()
        .from(transportRoutes)
        .where(
          and(
            eq(transportRoutes.id, routeId),
            eq(transportRoutes.institutionId, institutionId),
            isNull(transportRoutes.archivedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (!route) throw new NotFoundError('Transport route', routeId);
      if (route.status !== 'active') {
        throw new ConflictError('This route is inactive; reactivate it before assigning a vehicle.');
      }

      const vehicle = await this.loadVehicle(tx, institutionId, input.vehicleId);
      if (vehicle.status !== 'active') {
        throw new ConflictError(
          `This vehicle is recorded as ${vehicle.status} and cannot be assigned to a route.`,
        );
      }

      const driver = await this.loadDriver(tx, institutionId, input.driverId);
      if (driver.status !== 'active') {
        throw new ConflictError('This driver is inactive and cannot be assigned to a route.');
      }

      // One vehicle cannot serve two routes at once.
      const [elsewhere] = await tx
        .select({ id: routeVehicles.id, routeId: routeVehicles.routeId })
        .from(routeVehicles)
        .where(
          and(
            eq(routeVehicles.vehicleId, input.vehicleId),
            eq(routeVehicles.status, 'active'),
            isNull(routeVehicles.archivedAt),
          ),
        )
        .limit(1);
      if (elsewhere && elsewhere.routeId !== routeId) {
        throw new ConflictError('This vehicle is already actively assigned to another route.', {
          conflictingRouteId: elsewhere.routeId,
        });
      }

      // End the current assignment on this route, if any, in the same transaction.
      const current = await this.activeVehicleAssignmentRow(tx, routeId);
      if (current) {
        const endOn =
          compareCalendarDates(
            calendarDate(input.effectiveFrom),
            calendarDate(current.effectiveFrom),
          ) < 0
            ? current.effectiveFrom
            : input.effectiveFrom;
        await tx
          .update(routeVehicles)
          .set({
            status: 'ended',
            effectiveTo: endOn,
            updatedBy: principal.userId,
            version: current.version + 1,
          })
          .where(eq(routeVehicles.id, current.id));
      }

      const [created] = await tx
        .insert(routeVehicles)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          routeId,
          vehicleId: input.vehicleId,
          driverId: input.driverId,
          assistantName: input.assistantName ?? null,
          effectiveFrom: input.effectiveFrom,
          status: 'active',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();

      return {
        ...created!,
        registrationNumber: vehicle.registrationNumber,
        capacity: vehicle.capacity,
        driverName: driver.fullNameEn,
        endedAssignmentId: current?.id ?? null,
      };
    });
  }

  /** Take the vehicle off a route without a replacement. */
  async endVehicleAssignment(
    principal: Principal,
    institutionId: string,
    routeId: string,
    input: EndTransportVehicleAssignmentInput,
  ): Promise<RouteVehicleRow> {
    return this.db.runInTenant(async (tx) => {
      await this.loadRoute(tx, institutionId, routeId);

      const current = await this.activeVehicleAssignmentRow(tx, routeId);
      if (!current) throw new NotFoundError('Active vehicle assignment');

      if (
        compareCalendarDates(
          calendarDate(input.effectiveTo),
          calendarDate(current.effectiveFrom),
        ) < 0
      ) {
        throw new ValidationError('The end date cannot precede the assignment start', [
          { path: 'effectiveTo', message: `The assignment began on ${current.effectiveFrom}` },
        ]);
      }

      const [ended] = await tx
        .update(routeVehicles)
        .set({
          status: 'ended',
          effectiveTo: input.effectiveTo,
          updatedBy: principal.userId,
          version: current.version + 1,
        })
        .where(eq(routeVehicles.id, current.id))
        .returning();
      return ended!;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Student assignment
  // ══════════════════════════════════════════════════════════════════════════════════

  async listStudentAssignments(
    principal: Principal,
    institutionId: string,
    query: ListAssignmentsQuery,
    page: OffsetPageRequest,
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(studentTransport.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        studentTransport.archivedAt,
        query.includeArchived,
        'transport.assignments.manage',
      );
      if (query.routeId) filters.push(eq(studentTransport.routeId, query.routeId));
      if (query.stopId) filters.push(eq(studentTransport.stopId, query.stopId));
      if (query.studentId) filters.push(eq(studentTransport.studentId, query.studentId));
      if (query.status) {
        filters.push(
          eq(studentTransport.status, query.status as StudentTransportRow['status']),
        );
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, TRANSPORT_ASSIGNMENT_SORT_FIELDS, {
        field: 'effectiveFrom',
        direction: 'desc',
      }).map((spec) => {
        const column = ASSIGNMENT_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select({
          assignment: studentTransport,
          studentName: students.fullNameEn,
          studentCode: students.studentCode,
          routeCode: transportRoutes.code,
          stopName: routeStops.nameEn,
          stopFare: routeStops.fare,
        })
        .from(studentTransport)
        .innerJoin(students, eq(students.id, studentTransport.studentId))
        .innerJoin(transportRoutes, eq(transportRoutes.id, studentTransport.routeId))
        .innerJoin(routeStops, eq(routeStops.id, studentTransport.stopId))
        .where(where)
        .orderBy(...orderBy, asc(studentTransport.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(studentTransport)
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({
          ...row.assignment,
          studentName: row.studentName,
          studentCode: row.studentCode,
          routeCode: row.routeCode,
          stopName: row.stopName,
          /** The fare in force: the override when set, else the stop's fare. A string. */
          effectiveMonthlyFare: row.assignment.feeOverride ?? row.stopFare,
        })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  async assignStudent(
    principal: Principal,
    institutionId: string,
    input: AssignStudentTransportInput,
  ): Promise<StudentTransportRow> {
    return this.db.runInTenant(async (tx) => {
      const created = await this.assignStudentsInTx(tx, principal, institutionId, {
        routeId: input.routeId,
        stopId: input.stopId,
        direction: input.direction,
        effectiveFrom: input.effectiveFrom,
        feeOverride: input.feeOverride,
        studentIds: [input.studentId],
      });
      return created[0]!;
    });
  }

  /** All-or-nothing: one refused student (or a full bus) refuses the whole batch. */
  async bulkAssignStudents(
    principal: Principal,
    institutionId: string,
    input: BulkAssignStudentTransportInput,
  ): Promise<{ assigned: number; assignments: StudentTransportRow[] }> {
    return this.db.runInTenant(async (tx) => {
      const assignments = await this.assignStudentsInTx(tx, principal, institutionId, input);
      return { assigned: assignments.length, assignments };
    });
  }

  async endStudentAssignment(
    principal: Principal,
    institutionId: string,
    id: string,
    input: EndStudentTransportInput,
  ): Promise<StudentTransportRow> {
    return this.db.runInTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(studentTransport)
        .where(
          and(
            eq(studentTransport.id, id),
            eq(studentTransport.institutionId, institutionId),
            isNull(studentTransport.archivedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError('Student transport assignment', id);
      if (existing.status !== 'active') {
        throw new ConflictError('This assignment has already ended.');
      }

      if (
        compareCalendarDates(
          calendarDate(input.effectiveTo),
          calendarDate(existing.effectiveFrom),
        ) < 0
      ) {
        throw new ValidationError('The end date cannot precede the assignment start', [
          { path: 'effectiveTo', message: `The assignment began on ${existing.effectiveFrom}` },
        ]);
      }

      const [ended] = await tx
        .update(studentTransport)
        .set({
          status: 'ended',
          effectiveTo: input.effectiveTo,
          updatedBy: principal.userId,
          version: existing.version + 1,
        })
        .where(eq(studentTransport.id, id))
        .returning();
      return ended!;
    });
  }

  /**
   * The shared assignment path, called with one student or two hundred.
   *
   * The route row is locked first, so every capacity check in the institution serializes on
   * the route it concerns: the count of active assignments taken inside this transaction is
   * a fact, and two clerks racing for the last seat get the lock in turn — the second sees
   * the first's write and is refused with a clear 409.
   */
  private async assignStudentsInTx(
    tx: Tx,
    principal: Principal,
    institutionId: string,
    input: {
      routeId: string;
      stopId: string;
      direction: StudentTransportRow['direction'];
      effectiveFrom: string;
      feeOverride?: string;
      studentIds: string[];
    },
  ): Promise<StudentTransportRow[]> {
    const [route] = await tx
      .select()
      .from(transportRoutes)
      .where(
        and(
          eq(transportRoutes.id, input.routeId),
          eq(transportRoutes.institutionId, institutionId),
          isNull(transportRoutes.archivedAt),
        ),
      )
      .limit(1)
      .for('update');
    if (!route) throw new NotFoundError('Transport route', input.routeId);
    if (route.status !== 'active') {
      throw new ConflictError('This route is inactive and cannot take new assignments.');
    }

    const [stop] = await tx
      .select()
      .from(routeStops)
      .where(
        and(
          eq(routeStops.id, input.stopId),
          eq(routeStops.routeId, input.routeId),
          isNull(routeStops.archivedAt),
        ),
      )
      .limit(1);
    if (!stop) throw new NotFoundError('Route stop', input.stopId);

    const feeOverride = input.feeOverride
      ? Money.fromDecimalString(input.feeOverride).toDecimalString()
      : null;

    // Every named student must exist, live, in this institution.
    const found = await tx
      .select({ id: students.id })
      .from(students)
      .where(
        and(
          inArray(students.id, input.studentIds),
          eq(students.institutionId, institutionId),
          isNull(students.archivedAt),
        ),
      );
    const foundIds = new Set(found.map((row) => row.id));
    const missing = input.studentIds.find((id) => !foundIds.has(id));
    if (missing) throw new NotFoundError('Student', missing);

    // At most one ACTIVE assignment per student — pre-checked for a friendly message; the
    // partial unique index `student_transport_student_active_key` is the guarantee.
    const [alreadyAssigned] = await tx
      .select({ studentId: studentTransport.studentId })
      .from(studentTransport)
      .where(
        and(
          inArray(studentTransport.studentId, input.studentIds),
          eq(studentTransport.status, 'active'),
          isNull(studentTransport.archivedAt),
        ),
      )
      .limit(1);
    if (alreadyAssigned) {
      throw new ConflictError(
        'A student in this request already holds an active transport assignment. End it before assigning a new one.',
        { studentId: alreadyAssigned.studentId },
      );
    }

    // The capacity rule: assigned students must not exceed the active vehicle's seats.
    const activeVehicle = await this.activeVehicleAssignment(tx, input.routeId);
    if (activeVehicle) {
      const [assigned] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(studentTransport)
        .where(
          and(
            eq(studentTransport.routeId, input.routeId),
            eq(studentTransport.status, 'active'),
            isNull(studentTransport.archivedAt),
          ),
        );
      const current = assigned?.total ?? 0;
      if (current + input.studentIds.length > activeVehicle.capacity) {
        throw new ConflictError(
          `Route ${route.code} is over capacity: vehicle ${activeVehicle.registrationNumber} seats ` +
            `${activeVehicle.capacity}, ${current} student(s) are already assigned, and this request ` +
            `adds ${input.studentIds.length} more.`,
          {
            capacity: activeVehicle.capacity,
            currentlyAssigned: current,
            requested: input.studentIds.length,
          },
        );
      }
    }

    const created: StudentTransportRow[] = [];
    for (const studentId of input.studentIds) {
      const [row] = await tx
        .insert(studentTransport)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          studentId,
          routeId: input.routeId,
          stopId: input.stopId,
          direction: input.direction,
          effectiveFrom: input.effectiveFrom,
          feeOverride,
          status: 'active',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      created.push(row!);
    }
    return created;
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Trips and attendance
  // ══════════════════════════════════════════════════════════════════════════════════

  async listTrips(
    principal: Principal,
    institutionId: string,
    query: ListTripsQuery,
    page: OffsetPageRequest,
  ) {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(vehicleTrips.institutionId, institutionId)];
      this.applyArchiveFilter(
        principal,
        filters,
        vehicleTrips.archivedAt,
        query.includeArchived,
        'transport.assignments.manage',
      );
      if (query.routeId) filters.push(eq(routeVehicles.routeId, query.routeId));
      if (query.tripDate) filters.push(eq(vehicleTrips.tripDate, query.tripDate));
      if (query.direction) {
        filters.push(eq(vehicleTrips.direction, query.direction as TripRow['direction']));
      }

      const where = and(...filters);
      const orderBy = parseSort(query.sort, TRANSPORT_TRIP_SORT_FIELDS, {
        field: 'tripDate',
        direction: 'desc',
      }).map((spec) => {
        const column = TRIP_COLUMNS[spec.field];
        return spec.direction === 'desc' ? desc(column) : asc(column);
      });

      const rows = await tx
        .select({
          trip: vehicleTrips,
          routeId: routeVehicles.routeId,
          routeCode: transportRoutes.code,
          registrationNumber: vehicles.registrationNumber,
          driverName: drivers.fullNameEn,
        })
        .from(vehicleTrips)
        .innerJoin(routeVehicles, eq(routeVehicles.id, vehicleTrips.routeVehicleId))
        .innerJoin(transportRoutes, eq(transportRoutes.id, routeVehicles.routeId))
        .innerJoin(vehicles, eq(vehicles.id, routeVehicles.vehicleId))
        .innerJoin(drivers, eq(drivers.id, vehicleTrips.driverId))
        .where(where)
        .orderBy(...orderBy, asc(vehicleTrips.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(vehicleTrips)
        .innerJoin(routeVehicles, eq(routeVehicles.id, vehicleTrips.routeVehicleId))
        .where(where);

      return buildOffsetPage(
        rows.map((row) => ({
          ...row.trip,
          routeId: row.routeId,
          routeCode: row.routeCode,
          registrationNumber: row.registrationNumber,
          driverName: row.driverName,
        })),
        counted?.total ?? 0,
        page,
      );
    });
  }

  async startTrip(
    principal: Principal,
    institutionId: string,
    input: StartVehicleTripInput,
  ): Promise<TripRow> {
    const tripDate = input.tripDate ?? (todayInDhaka() as string);

    return this.db.runInTenant(async (tx) => {
      await this.loadRoute(tx, institutionId, input.routeId);

      const assignment = await this.activeVehicleAssignmentRow(tx, input.routeId);
      if (!assignment) {
        throw new ConflictError(
          'This route has no active vehicle assignment; assign a vehicle before starting a trip.',
        );
      }

      const driverId = input.driverId ?? assignment.driverId;
      if (input.driverId) await this.loadDriver(tx, institutionId, input.driverId);

      // Pre-checked for a friendly message; `vehicle_trips_daily_key` is the guarantee.
      const [existing] = await tx
        .select({ id: vehicleTrips.id })
        .from(vehicleTrips)
        .where(
          and(
            eq(vehicleTrips.routeVehicleId, assignment.id),
            eq(vehicleTrips.tripDate, tripDate),
            eq(vehicleTrips.direction, input.direction),
            isNull(vehicleTrips.archivedAt),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError(
          `The ${input.direction} trip for ${tripDate} has already been started on this route.`,
          { existingTripId: existing.id },
        );
      }

      const [created] = await tx
        .insert(vehicleTrips)
        .values({
          id: uuidv7(),
          tenantId: principal.tenantId!,
          institutionId,
          routeVehicleId: assignment.id,
          tripDate,
          direction: input.direction,
          startedAt: new Date(),
          odometerStart: input.odometerStart,
          driverId,
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning();
      return created!;
    });
  }

  async endTrip(
    principal: Principal,
    institutionId: string,
    id: string,
    input: EndVehicleTripInput,
  ): Promise<TripRow> {
    return this.db.runInTenant(async (tx) => {
      const trip = await this.loadTrip(tx, institutionId, id);
      if (trip.endedAt) {
        throw new ConflictError('This trip has already been ended.');
      }
      if (input.odometerEnd < trip.odometerStart) {
        throw new ValidationError('The closing odometer reading cannot be below the opening one', [
          { path: 'odometerEnd', message: `The trip started at ${trip.odometerStart}` },
        ]);
      }

      const [ended] = await tx
        .update(vehicleTrips)
        .set({
          endedAt: new Date(),
          odometerEnd: input.odometerEnd,
          updatedBy: principal.userId,
          version: trip.version + 1,
        })
        .where(and(eq(vehicleTrips.id, id), eq(vehicleTrips.version, input.version)))
        .returning();

      if (!ended) {
        throw new ConflictError(
          'This trip was changed by someone else while you were editing. Reload and try again.',
          { expectedVersion: input.version, currentVersion: trip.version },
        );
      }
      return ended;
    });
  }

  /**
   * Mark who boarded, was absent, or was dropped on a trip. One row per student per trip
   * (`trip_attendance_trip_student_key`); re-marking updates the row. Only students actively
   * assigned to the trip's route can be marked — a name outside the manifest is a mistake,
   * not data.
   */
  async markTripAttendance(
    principal: Principal,
    institutionId: string,
    tripId: string,
    input: MarkTripAttendanceInput,
  ) {
    return this.db.runInTenant(async (tx) => {
      const trip = await this.loadTrip(tx, institutionId, tripId);

      const [assignment] = await tx
        .select({ routeId: routeVehicles.routeId })
        .from(routeVehicles)
        .where(eq(routeVehicles.id, trip.routeVehicleId))
        .limit(1);
      if (!assignment) throw new NotFoundError('Route vehicle assignment', trip.routeVehicleId);

      const studentIds = input.entries.map((entry) => entry.studentId);
      const manifest = await tx
        .select({
          studentId: studentTransport.studentId,
          stopId: studentTransport.stopId,
        })
        .from(studentTransport)
        .where(
          and(
            eq(studentTransport.routeId, assignment.routeId),
            eq(studentTransport.status, 'active'),
            isNull(studentTransport.archivedAt),
            inArray(studentTransport.studentId, studentIds),
          ),
        );
      const manifestByStudent = new Map(manifest.map((row) => [row.studentId, row]));

      const marked: Array<{ studentId: string; status: string; attendanceId: string }> = [];
      for (const entry of input.entries) {
        const onManifest = manifestByStudent.get(entry.studentId);
        if (!onManifest) {
          throw new ConflictError(
            'A student in this request is not actively assigned to this route.',
            { studentId: entry.studentId },
          );
        }

        const stopId = entry.stopId ?? onManifest.stopId;
        const [existing] = await tx
          .select()
          .from(tripAttendance)
          .where(
            and(
              eq(tripAttendance.tripId, tripId),
              eq(tripAttendance.studentId, entry.studentId),
              isNull(tripAttendance.archivedAt),
            ),
          )
          .limit(1);

        if (existing) {
          const [updated] = await tx
            .update(tripAttendance)
            .set({
              status: entry.status,
              stopId,
              recordedAt: new Date(),
              updatedBy: principal.userId,
              version: existing.version + 1,
            })
            .where(eq(tripAttendance.id, existing.id))
            .returning();
          marked.push({
            studentId: entry.studentId,
            status: entry.status,
            attendanceId: updated!.id,
          });
        } else {
          const [created] = await tx
            .insert(tripAttendance)
            .values({
              id: uuidv7(),
              tenantId: principal.tenantId!,
              institutionId,
              tripId,
              studentId: entry.studentId,
              status: entry.status,
              recordedAt: new Date(),
              stopId,
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning();
          marked.push({
            studentId: entry.studentId,
            status: entry.status,
            attendanceId: created!.id,
          });
        }
      }

      return { tripId, marked: marked.length, entries: marked };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Self-service and live position
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * The caller's own children's transport — route, stop, fare and recent trip attendance.
   *
   * The student set is derived from the principal's identity (their own student record, or
   * the children linked to their guardian record with portal access); there is no parameter
   * through which anybody can name somebody else, and a caller with neither identity gets an
   * empty result rather than an error. Failing closed is the only safe reading.
   */
  async myChildTransport(principal: Principal, institutionId: string) {
    return this.db.runInTenant(async (tx) => {
      const studentIds = await this.ownStudentIds(tx, principal);
      if (studentIds.length === 0) return { children: [] };

      const rows = await tx
        .select({
          student: { id: students.id, fullNameEn: students.fullNameEn, studentCode: students.studentCode },
          assignment: studentTransport,
          routeCode: transportRoutes.code,
          routeName: transportRoutes.nameEn,
          stopName: routeStops.nameEn,
          stopFare: routeStops.fare,
          pickupTime: routeStops.pickupTime,
          dropTime: routeStops.dropTime,
        })
        .from(students)
        .leftJoin(
          studentTransport,
          and(
            eq(studentTransport.studentId, students.id),
            eq(studentTransport.status, 'active'),
            isNull(studentTransport.archivedAt),
          ),
        )
        .leftJoin(transportRoutes, eq(transportRoutes.id, studentTransport.routeId))
        .leftJoin(routeStops, eq(routeStops.id, studentTransport.stopId))
        .where(
          and(
            inArray(students.id, studentIds),
            eq(students.institutionId, institutionId),
            isNull(students.archivedAt),
          ),
        )
        .orderBy(asc(students.fullNameEn));

      const attendance = await tx
        .select({
          attendance: tripAttendance,
          tripDate: vehicleTrips.tripDate,
          direction: vehicleTrips.direction,
        })
        .from(tripAttendance)
        .innerJoin(vehicleTrips, eq(vehicleTrips.id, tripAttendance.tripId))
        .where(
          and(
            inArray(tripAttendance.studentId, studentIds),
            isNull(tripAttendance.archivedAt),
          ),
        )
        .orderBy(desc(tripAttendance.recordedAt))
        .limit(200);

      const children = rows.map((row) => ({
        student: row.student,
        assignment: row.assignment
          ? {
              id: row.assignment.id,
              routeId: row.assignment.routeId,
              routeCode: row.routeCode,
              routeName: row.routeName,
              stopId: row.assignment.stopId,
              stopName: row.stopName,
              direction: row.assignment.direction,
              effectiveFrom: row.assignment.effectiveFrom,
              pickupTime: row.pickupTime,
              dropTime: row.dropTime,
              /** The fare in force: override when set, else the stop's fare. A string. */
              monthlyFare: row.assignment.feeOverride ?? row.stopFare,
            }
          : null,
        tripAttendance: attendance
          .filter((entry) => entry.attendance.studentId === row.student.id)
          .map((entry) => ({
            id: entry.attendance.id,
            tripId: entry.attendance.tripId,
            tripDate: entry.tripDate,
            direction: entry.direction,
            status: entry.attendance.status,
            recordedAt: entry.attendance.recordedAt,
          })),
      }));

      return { children };
    });
  }

  /**
   * The live position of the vehicle serving a route, from the configured GPS provider.
   *
   * Staff holding any transport-manage permission may ask about any route. Everyone else —
   * a guardian, a student — is answered only for a route their own child (or they
   * themselves) is *actively* assigned to; any other route id gets a 404, never a 403,
   * because confirming the route exists is itself a leak. The provider is consulted last:
   * no adapter, mock included, is ever asked about a vehicle the caller may not see.
   */
  async livePosition(principal: Principal, institutionId: string, routeId: string) {
    const staffMayView =
      can(principal, 'transport.routes.manage') ||
      can(principal, 'transport.vehicles.manage') ||
      can(principal, 'transport.assignments.manage');

    const { route, vehicle } = await this.db.runInTenant(async (tx) => {
      const loadedRoute = await this.loadRoute(tx, institutionId, routeId);

      if (!staffMayView) {
        const studentIds = await this.ownStudentIds(tx, principal);
        let linked = false;
        if (studentIds.length > 0) {
          const [assignment] = await tx
            .select({ id: studentTransport.id })
            .from(studentTransport)
            .where(
              and(
                eq(studentTransport.routeId, routeId),
                inArray(studentTransport.studentId, studentIds),
                eq(studentTransport.status, 'active'),
                isNull(studentTransport.archivedAt),
              ),
            )
            .limit(1);
          linked = Boolean(assignment);
        }
        if (!linked) {
          // 404, not 403: a route the caller's child is not on does not exist for them.
          throw new NotFoundError('Transport route', routeId);
        }
      }

      const assignment = await this.activeVehicleAssignment(tx, routeId);
      if (!assignment) {
        throw new NotFoundError('Active vehicle assignment');
      }

      return {
        route: loadedRoute,
        vehicle: {
          vehicleId: assignment.vehicleId,
          registrationNumber: assignment.registrationNumber,
        },
      };
    });

    const provider = this.gps.active();
    const position = await provider.fetchPosition(vehicle);

    return {
      routeId: route.id,
      routeCode: route.code,
      vehicleId: vehicle.vehicleId,
      registrationNumber: vehicle.registrationNumber,
      provider: provider.key,
      position,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Reports
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * Vehicle insurance and fitness certificates and driver licences that have expired or
   * will expire within the window. This report is the whole of the expiry mechanism:
   * nothing suspends a vehicle or driver automatically — a human reads this and acts.
   */
  async expiringDocuments(institutionId: string, withinDays: number) {
    const today = todayInDhaka();
    const threshold = addDays(today, withinDays) as string;

    return this.db.runInTenant(async (tx) => {
      const vehicleRows = await tx
        .select({
          id: vehicles.id,
          registrationNumber: vehicles.registrationNumber,
          status: vehicles.status,
          insuranceExpiry: vehicles.insuranceExpiry,
          fitnessExpiry: vehicles.fitnessExpiry,
        })
        .from(vehicles)
        .where(
          and(
            eq(vehicles.institutionId, institutionId),
            isNull(vehicles.archivedAt),
            or(
              and(isNotNull(vehicles.insuranceExpiry), lte(vehicles.insuranceExpiry, threshold)),
              and(isNotNull(vehicles.fitnessExpiry), lte(vehicles.fitnessExpiry, threshold)),
            )!,
          ),
        );

      const driverRows = await tx
        .select({
          id: drivers.id,
          fullNameEn: drivers.fullNameEn,
          licenceNumber: drivers.licenceNumber,
          status: drivers.status,
          licenceExpiry: drivers.licenceExpiry,
        })
        .from(drivers)
        .where(
          and(
            eq(drivers.institutionId, institutionId),
            isNull(drivers.archivedAt),
            lte(drivers.licenceExpiry, threshold),
          ),
        );

      const items: Array<{
        documentType: 'vehicle_insurance' | 'vehicle_fitness' | 'driver_licence';
        subjectId: string;
        subjectLabel: string;
        subjectStatus: string;
        expiresOn: string;
        /** Negative when already expired. */
        daysRemaining: number;
      }> = [];

      for (const vehicle of vehicleRows) {
        if (vehicle.insuranceExpiry && vehicle.insuranceExpiry <= threshold) {
          items.push({
            documentType: 'vehicle_insurance',
            subjectId: vehicle.id,
            subjectLabel: vehicle.registrationNumber,
            subjectStatus: vehicle.status,
            expiresOn: vehicle.insuranceExpiry,
            daysRemaining: daysBetween(today, calendarDate(vehicle.insuranceExpiry)),
          });
        }
        if (vehicle.fitnessExpiry && vehicle.fitnessExpiry <= threshold) {
          items.push({
            documentType: 'vehicle_fitness',
            subjectId: vehicle.id,
            subjectLabel: vehicle.registrationNumber,
            subjectStatus: vehicle.status,
            expiresOn: vehicle.fitnessExpiry,
            daysRemaining: daysBetween(today, calendarDate(vehicle.fitnessExpiry)),
          });
        }
      }
      for (const driver of driverRows) {
        items.push({
          documentType: 'driver_licence',
          subjectId: driver.id,
          subjectLabel: `${driver.fullNameEn} (${driver.licenceNumber})`,
          subjectStatus: driver.status,
          expiresOn: driver.licenceExpiry,
          daysRemaining: daysBetween(today, calendarDate(driver.licenceExpiry)),
        });
      }

      items.sort((a, b) => a.daysRemaining - b.daysRemaining);

      return {
        asOfDate: today as string,
        withinDays,
        itemCount: items.length,
        alreadyExpired: items.filter((item) => item.daysRemaining < 0).length,
        items,
      };
    });
  }

  /** Seats versus assignments, per active route, counted by Postgres. */
  async occupancyReport(institutionId: string) {
    return this.db.runInTenant(async (tx) => {
      const routes = await tx
        .select()
        .from(transportRoutes)
        .where(
          and(
            eq(transportRoutes.institutionId, institutionId),
            isNull(transportRoutes.archivedAt),
          ),
        )
        .orderBy(asc(transportRoutes.code));

      const counts = await tx
        .select({
          routeId: studentTransport.routeId,
          total: sql<number>`count(*)::int`,
        })
        .from(studentTransport)
        .where(
          and(
            eq(studentTransport.institutionId, institutionId),
            eq(studentTransport.status, 'active'),
            isNull(studentTransport.archivedAt),
          ),
        )
        .groupBy(studentTransport.routeId);
      const countByRoute = new Map(counts.map((row) => [row.routeId, row.total]));

      const activeAssignments = await tx
        .select({
          routeId: routeVehicles.routeId,
          vehicleId: routeVehicles.vehicleId,
          registrationNumber: vehicles.registrationNumber,
          capacity: vehicles.capacity,
        })
        .from(routeVehicles)
        .innerJoin(vehicles, eq(vehicles.id, routeVehicles.vehicleId))
        .where(
          and(
            eq(routeVehicles.institutionId, institutionId),
            eq(routeVehicles.status, 'active'),
            isNull(routeVehicles.archivedAt),
          ),
        );
      const vehicleByRoute = new Map(activeAssignments.map((row) => [row.routeId, row]));

      const rows = routes.map((route) => {
        const vehicle = vehicleByRoute.get(route.id) ?? null;
        const assignedStudents = countByRoute.get(route.id) ?? 0;
        return {
          routeId: route.id,
          routeCode: route.code,
          routeName: route.nameEn,
          routeStatus: route.status,
          vehicleId: vehicle?.vehicleId ?? null,
          registrationNumber: vehicle?.registrationNumber ?? null,
          capacity: vehicle?.capacity ?? null,
          assignedStudents,
          seatsAvailable: vehicle ? vehicle.capacity - assignedStudents : null,
        };
      });

      return { routeCount: rows.length, rows };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Fee integration
  // ══════════════════════════════════════════════════════════════════════════════════

  /**
   * **The fee-module integration surface.** One row per student whose transport assignment
   * overlaps `[periodStart, periodEnd]`, with the monthly fare resolved as
   * `coalesce(fee_override, stop.fare)` — a decimal string ready for `Money`.
   *
   * Runs in the **caller's** transaction, so the fees module can read these figures inside
   * its own invoice-generation transaction and post them under its own audit trail. This
   * service never writes into a fee table; that boundary is the design.
   *
   * An assignment overlaps the period when `effective_from <= periodEnd` and
   * `(effective_to is null or effective_to >= periodStart)` — an assignment that ended
   * mid-month still appears, because the family rode that month and billing part-months is
   * a fee-module policy decision, not a transport fact.
   */
  async faresForBillingPeriod(
    tx: Tx,
    institutionId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<TransportFareRow[]> {
    const rows = await tx
      .select({
        studentId: studentTransport.studentId,
        routeId: studentTransport.routeId,
        routeCode: transportRoutes.code,
        stopId: studentTransport.stopId,
        stopName: routeStops.nameEn,
        direction: studentTransport.direction,
        feeOverride: studentTransport.feeOverride,
        stopFare: routeStops.fare,
      })
      .from(studentTransport)
      .innerJoin(transportRoutes, eq(transportRoutes.id, studentTransport.routeId))
      .innerJoin(routeStops, eq(routeStops.id, studentTransport.stopId))
      .where(
        and(
          eq(studentTransport.institutionId, institutionId),
          isNull(studentTransport.archivedAt),
          lte(studentTransport.effectiveFrom, periodEnd),
          or(
            isNull(studentTransport.effectiveTo),
            gte(studentTransport.effectiveTo, periodStart),
          )!,
        ),
      )
      .orderBy(asc(transportRoutes.code), asc(routeStops.sequence), asc(studentTransport.id));

    return rows.map((row) => ({
      studentId: row.studentId,
      routeId: row.routeId,
      routeCode: row.routeCode,
      stopId: row.stopId,
      stopName: row.stopName,
      direction: row.direction,
      // The resolution is restated here, not baked into a stored column, so a fare change
      // on the stop takes effect on the next billing run without a backfill.
      monthlyFare: Money.fromDecimalString(row.feeOverride ?? row.stopFare).toDecimalString(),
    }));
  }

  /** The HTTP view over `faresForBillingPeriod`, with student names and a total. */
  async monthlyFeeSchedule(institutionId: string, month: string) {
    const periodStart = calendarDate(`${month}-01`);
    const periodEnd = addDays(addMonths(periodStart, 1), -1);

    return this.db.runInTenant(async (tx) => {
      const fares = await this.faresForBillingPeriod(
        tx,
        institutionId,
        periodStart as string,
        periodEnd as string,
      );

      const names =
        fares.length > 0
          ? await tx
              .select({
                id: students.id,
                fullNameEn: students.fullNameEn,
                studentCode: students.studentCode,
              })
              .from(students)
              .where(
                inArray(
                  students.id,
                  fares.map((row) => row.studentId),
                ),
              )
          : [];
      const nameById = new Map(names.map((row) => [row.id, row]));

      const total = Money.sum(fares.map((row) => Money.fromDecimalString(row.monthlyFare)));

      return {
        month,
        periodStart: periodStart as string,
        periodEnd: periodEnd as string,
        studentCount: fares.length,
        /** Money as a string, never a number, on the wire too. */
        totalMonthlyFares: total.toDecimalString(),
        rows: fares.map((row) => ({
          ...row,
          studentName: nameById.get(row.studentId)?.fullNameEn ?? null,
          studentCode: nameById.get(row.studentId)?.studentCode ?? null,
        })),
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════
  // Internals
  // ══════════════════════════════════════════════════════════════════════════════════

  private applyArchiveFilter(
    principal: Principal,
    filters: SQL[],
    archivedAtColumn: SQLWrapper,
    includeArchived: boolean,
    permission: Permission,
  ): void {
    if (!includeArchived) {
      filters.push(isNull(archivedAtColumn));
      return;
    }
    if (!can(principal, permission)) {
      throw new ForbiddenError(permission, 'You cannot view archived transport records');
    }
  }

  private async loadVehicle(tx: Tx, institutionId: string, id: string): Promise<VehicleRow> {
    const [row] = await tx
      .select()
      .from(vehicles)
      .where(
        and(
          eq(vehicles.id, id),
          eq(vehicles.institutionId, institutionId),
          isNull(vehicles.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Vehicle', id);
    return row;
  }

  private async loadDriver(tx: Tx, institutionId: string, id: string): Promise<DriverRow> {
    const [row] = await tx
      .select()
      .from(drivers)
      .where(
        and(
          eq(drivers.id, id),
          eq(drivers.institutionId, institutionId),
          isNull(drivers.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Driver', id);
    return row;
  }

  private async loadRoute(tx: Tx, institutionId: string, id: string): Promise<RouteRow> {
    const [row] = await tx
      .select()
      .from(transportRoutes)
      .where(
        and(
          eq(transportRoutes.id, id),
          eq(transportRoutes.institutionId, institutionId),
          isNull(transportRoutes.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Transport route', id);
    return row;
  }

  private async loadTrip(tx: Tx, institutionId: string, id: string): Promise<TripRow> {
    const [row] = await tx
      .select()
      .from(vehicleTrips)
      .where(
        and(
          eq(vehicleTrips.id, id),
          eq(vehicleTrips.institutionId, institutionId),
          isNull(vehicleTrips.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Vehicle trip', id);
    return row;
  }

  private async assertCampus(tx: Tx, institutionId: string, campusId: string): Promise<void> {
    const [row] = await tx
      .select({ id: campuses.id })
      .from(campuses)
      .where(
        and(
          eq(campuses.id, campusId),
          eq(campuses.institutionId, institutionId),
          isNull(campuses.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Campus', campusId);
  }

  private async assertShift(tx: Tx, institutionId: string, shiftId: string): Promise<void> {
    const [row] = await tx
      .select({ id: shifts.id })
      .from(shifts)
      .where(
        and(
          eq(shifts.id, shiftId),
          eq(shifts.institutionId, institutionId),
          isNull(shifts.archivedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Shift', shiftId);
  }

  /** The active assignment row on a route, or null. */
  private async activeVehicleAssignmentRow(
    tx: Tx,
    routeId: string,
  ): Promise<RouteVehicleRow | null> {
    const [row] = await tx
      .select()
      .from(routeVehicles)
      .where(
        and(
          eq(routeVehicles.routeId, routeId),
          eq(routeVehicles.status, 'active'),
          isNull(routeVehicles.archivedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The active assignment with its vehicle and driver joined, or null. */
  private async activeVehicleAssignment(tx: Tx, routeId: string) {
    const [row] = await tx
      .select({
        assignment: routeVehicles,
        registrationNumber: vehicles.registrationNumber,
        capacity: vehicles.capacity,
        vehicleStatus: vehicles.status,
        driverName: drivers.fullNameEn,
        driverPhone: drivers.phone,
      })
      .from(routeVehicles)
      .innerJoin(vehicles, eq(vehicles.id, routeVehicles.vehicleId))
      .innerJoin(drivers, eq(drivers.id, routeVehicles.driverId))
      .where(
        and(
          eq(routeVehicles.routeId, routeId),
          eq(routeVehicles.status, 'active'),
          isNull(routeVehicles.archivedAt),
        ),
      )
      .limit(1);

    if (!row) return null;
    return {
      ...row.assignment,
      registrationNumber: row.registrationNumber,
      capacity: row.capacity,
      vehicleStatus: row.vehicleStatus,
      driverName: row.driverName,
      driverPhone: row.driverPhone,
    };
  }

  /**
   * The students this principal may see as "their own": themselves when they are a student,
   * and the children linked to their guardian record with portal access. Failing closed —
   * neither identity means an empty set, never an error and never a wider read.
   */
  private async ownStudentIds(tx: Tx, principal: Principal): Promise<string[]> {
    const ids = new Set<string>();
    if (principal.studentId) ids.add(principal.studentId);

    if (principal.guardianId) {
      const links = await tx
        .select({ studentId: studentGuardians.studentId })
        .from(studentGuardians)
        .where(
          and(
            eq(studentGuardians.guardianId, principal.guardianId),
            // Revoking portal access takes effect on the next request.
            eq(studentGuardians.canAccessPortal, true),
            isNull(studentGuardians.archivedAt),
          ),
        );
      for (const link of links) ids.add(link.studentId);
    }

    return [...ids];
  }
}

// ────────────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────────────────

function diffOf<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: string[],
): Partial<T> {
  const previous: Partial<T> = {};
  for (const key of keys) {
    const typedKey = key as keyof T;
    if (before[typedKey] !== after[typedKey]) {
      (previous as Record<string, unknown>)[key] = before[typedKey];
    }
  }
  return previous;
}

// ── Sort-column maps ─────────────────────────────────────────────────────────────────

const VEHICLE_COLUMNS = {
  registrationNumber: vehicles.registrationNumber,
  capacity: vehicles.capacity,
  status: vehicles.status,
  insuranceExpiry: vehicles.insuranceExpiry,
  fitnessExpiry: vehicles.fitnessExpiry,
  createdAt: vehicles.createdAt,
} as const;

const DRIVER_COLUMNS = {
  fullNameEn: drivers.fullNameEn,
  licenceExpiry: drivers.licenceExpiry,
  status: drivers.status,
  createdAt: drivers.createdAt,
} as const;

const ROUTE_COLUMNS = {
  code: transportRoutes.code,
  nameEn: transportRoutes.nameEn,
  status: transportRoutes.status,
  createdAt: transportRoutes.createdAt,
} as const;

const ASSIGNMENT_COLUMNS = {
  effectiveFrom: studentTransport.effectiveFrom,
  status: studentTransport.status,
  createdAt: studentTransport.createdAt,
} as const;

const TRIP_COLUMNS = {
  tripDate: vehicleTrips.tripDate,
  startedAt: vehicleTrips.startedAt,
  createdAt: vehicleTrips.createdAt,
} as const;
