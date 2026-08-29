/**
 * Transport management (Phase 18).
 *
 * The structural decisions worth stating:
 *
 *  - **One ACTIVE vehicle per route, and one ACTIVE transport assignment per student, are
 *    database properties.** The partial unique indexes `route_vehicles_route_active_key`
 *    (`(route_id) WHERE status = 'active' AND archived_at IS NULL`) and
 *    `student_transport_student_active_key` (`(student_id) WHERE status = 'active' AND
 *    archived_at IS NULL`) are the guarantees; the service's checks are a courtesy that
 *    produces better error messages. Two clerks assigning the same student at the same
 *    moment collide in Postgres, not in a race the application happened to lose.
 *  - **Coordinates are `numeric`, never a float.** `numeric(9, 6)` gives ~11cm of precision
 *    at the equator, far beyond what a bus stop needs, and the CHECK constraints
 *    (`route_stops_latitude_range`, `route_stops_longitude_range`) refuse a coordinate off
 *    the planet at the database rather than trusting a form.
 *  - **Money is `numeric(14, 2)`** — a stop's fare, a student's fee override, a maintenance
 *    bill — parsed only by `Money.fromDecimalString` and written only by
 *    `Money.toDecimalString`.
 *  - **Nothing is deleted.** A retired bus keeps its trip history; an ended assignment keeps
 *    its dates; replacing a route's stop set archives the removed stops with a reason rather
 *    than deleting rows a `student_transport` record still points at.
 *  - **Expiry dates produce a report, not an automatic suspension.** Insurance, fitness and
 *    licence expiries feed the expiring-documents report; a human decides what to do about a
 *    vehicle whose paperwork lapsed. Nothing here flips a status by itself.
 *
 * Enum note: every value set below is genuinely closed — adding a trip direction or an
 * attendance status changes the trip code as well as the schema. Maintenance *kinds* a school
 * invents for itself ("engine overhaul", "seat repair") are free text, not an enum.
 */

import { relations, sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  actorColumns,
  archiveColumns,
  primaryKeyColumn,
  timestampColumns,
  versionColumn,
} from './_shared';
import { campuses, institutions, organizations } from './tenancy';
import { shifts } from './academic';
import { students } from './students';
import { employees } from './people';

// ─────────────────────────────────────────────────────────────────────────────────────
// Enumerations. All prefixed `transport_` so they can never collide with another module.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * `maintenance` and `retired` are set by humans through the audited endpoints; nothing —
 * including an expired fitness certificate — moves a vehicle out of `active` automatically.
 */
export const transportVehicleStatusEnum = pgEnum('transport_vehicle_status', [
  'active',
  'maintenance',
  'retired',
]);

export const transportFuelTypeEnum = pgEnum('transport_fuel_type', [
  'diesel',
  'petrol',
  'octane',
  'cng',
  'lpg',
  'electric',
  'other',
]);

export const transportDriverStatusEnum = pgEnum('transport_driver_status', [
  'active',
  'inactive',
]);

/** Shared by vehicle-to-route and student-to-route assignments: live, or closed with dates. */
export const transportAssignmentStatusEnum = pgEnum('transport_assignment_status', [
  'active',
  'ended',
]);

/** Which legs of the day a student rides. */
export const transportDirectionEnum = pgEnum('transport_direction', ['pickup', 'drop', 'both']);

/** A single trip runs one leg; there is no `both` trip. */
export const transportTripDirectionEnum = pgEnum('transport_trip_direction', ['pickup', 'drop']);

export const transportTripAttendanceStatusEnum = pgEnum('transport_trip_attendance_status', [
  'boarded',
  'absent',
  'dropped',
]);

// ─────────────────────────────────────────────────────────────────────────────────────
// Fleet
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One bus, van or microbus. `registration_number` is the BRTA plate — unique per institution
 * among live rows, so a retired vehicle's plate stays in the record while the number can be
 * legitimately reused if the school buys the plate back.
 *
 * `insurance_expiry` and `fitness_expiry` feed the expiring-documents report. They suspend
 * nothing by themselves — a human reads the report and acts.
 */
export const vehicles = pgTable(
  'vehicles',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    registrationNumber: varchar('registration_number', { length: 32 }).notNull(),
    model: varchar('model', { length: 128 }),
    /** Seats. The route capacity rule reads this from the route's ACTIVE vehicle. */
    capacity: smallint('capacity').notNull(),
    fuelType: transportFuelTypeEnum('fuel_type').notNull().default('diesel'),
    insuranceExpiry: date('insurance_expiry'),
    fitnessExpiry: date('fitness_expiry'),
    status: transportVehicleStatusEnum('status').notNull().default('active'),
    notes: varchar('notes', { length: 1000 }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('vehicles_institution_registration_key')
      .on(table.institutionId, table.registrationNumber)
      .where(sql`${table.archivedAt} IS NULL`),
    index('vehicles_tenant_idx').on(table.tenantId),
    index('vehicles_institution_status_idx').on(table.institutionId, table.status),
  ],
);

/**
 * A driver. `employee_id` is nullable because many schools contract drivers who are not on
 * the payroll; when it is present it links to exactly one live driver record.
 */
export const drivers = pgTable(
  'drivers',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** Null for contracted drivers with no HR record. */
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'restrict' }),
    fullNameEn: varchar('full_name_en', { length: 255 }).notNull(),
    fullNameBn: varchar('full_name_bn', { length: 255 }),
    phone: varchar('phone', { length: 20 }).notNull(),
    licenceNumber: varchar('licence_number', { length: 64 }).notNull(),
    /** Feeds the expiring-documents report. Expiry suspends nothing automatically. */
    licenceExpiry: date('licence_expiry').notNull(),
    status: transportDriverStatusEnum('status').notNull().default('active'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('drivers_institution_licence_key')
      .on(table.institutionId, table.licenceNumber)
      .where(sql`${table.archivedAt} IS NULL`),
    // One live driver record per employee, when the driver is on the payroll at all.
    uniqueIndex('drivers_employee_key')
      .on(table.employeeId)
      .where(sql`${table.employeeId} IS NOT NULL AND ${table.archivedAt} IS NULL`),
    index('drivers_tenant_idx').on(table.tenantId),
    index('drivers_institution_status_idx').on(table.institutionId, table.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Routes and stops
// ─────────────────────────────────────────────────────────────────────────────────────

export const transportRoutes = pgTable(
  'transport_routes',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    /** The campus the route converges on. */
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campuses.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    /** The school shift this route serves, when the school runs shifts. */
    shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'restrict' }),
    /** One-way distance. Not money, but still exact — a float km reads badly on a notice. */
    distanceKm: numeric('distance_km', { precision: 8, scale: 2 }),
    /** `'active' | 'inactive'` — an inactive route accepts no new assignments or trips. */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('transport_routes_institution_code_key')
      .on(table.institutionId, table.code)
      .where(sql`${table.archivedAt} IS NULL`),
    index('transport_routes_tenant_idx').on(table.tenantId),
    index('transport_routes_institution_status_idx').on(table.institutionId, table.status),
    index('transport_routes_campus_idx').on(table.campusId),
    index('transport_routes_shift_idx').on(table.shiftId),
  ],
);

/**
 * One stop on one route. The stop set is replaced whole (a PUT) with a contiguous sequence;
 * a stop removed from the set is archived, never deleted, because `student_transport` rows
 * point at it and an assignment's history must keep naming the stop it was for.
 *
 * The fare is the monthly charge for boarding at this stop — the per-student figure the fee
 * schedule reads, unless the assignment carries an override.
 */
export const routeStops = pgTable(
  'route_stops',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    routeId: uuid('route_id')
      .notNull()
      .references(() => transportRoutes.id, { onDelete: 'restrict' }),
    /** 1-based position along the route. Contiguous among live stops, by construction. */
    sequence: smallint('sequence').notNull(),
    nameEn: varchar('name_en', { length: 128 }).notNull(),
    nameBn: varchar('name_bn', { length: 128 }),
    /** numeric(9,6), range-checked in the database. Never a float. */
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    pickupTime: time('pickup_time'),
    dropTime: time('drop_time'),
    /** Monthly fare for this stop. Money, never a float. */
    fare: numeric('fare', { precision: 14, scale: 2 }).notNull().default('0.00'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('route_stops_route_sequence_key')
      .on(table.routeId, table.sequence)
      .where(sql`${table.archivedAt} IS NULL`),
    index('route_stops_tenant_idx').on(table.tenantId),
    index('route_stops_route_idx').on(table.routeId, table.sequence),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Assignments
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Which vehicle (and driver) serves a route, and since when.
 *
 * **`route_vehicles_route_active_key`** — unique on `(route_id)` where `status = 'active'
 * and archived_at is null` — is the single-active-vehicle guarantee, and it is a property of
 * the database. Assigning a replacement ends the current assignment and creates the next in
 * one transaction; a concurrent double-assign is refused by Postgres with a unique violation
 * (surfaced as a 409), not by an application check a race can slip past.
 */
export const routeVehicles = pgTable(
  'route_vehicles',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    routeId: uuid('route_id')
      .notNull()
      .references(() => transportRoutes.id, { onDelete: 'restrict' }),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'restrict' }),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'restrict' }),
    /** The helper ("helper/khalashi") who rides along. Free text — rarely a payroll person. */
    assistantName: varchar('assistant_name', { length: 128 }),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    status: transportAssignmentStatusEnum('status').notNull().default('active'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // THE fleet-assignment invariant: at most one ACTIVE vehicle per route, in Postgres.
    uniqueIndex('route_vehicles_route_active_key')
      .on(table.routeId)
      .where(sql`${table.status} = 'active' AND ${table.archivedAt} IS NULL`),
    index('route_vehicles_tenant_idx').on(table.tenantId),
    index('route_vehicles_route_idx').on(table.routeId, table.status),
    index('route_vehicles_vehicle_idx').on(table.vehicleId, table.status),
    index('route_vehicles_driver_idx').on(table.driverId),
  ],
);

/**
 * A student's place on a route, boarding at one stop.
 *
 * **`student_transport_student_active_key`** — unique on `(student_id)` where
 * `status = 'active' and archived_at is null` — guarantees at most one ACTIVE transport
 * assignment per student at the database level. `fee_override` replaces the stop's fare for
 * this student when set (a sibling discount, a staff child); the fee schedule reads
 * `coalesce(fee_override, stop.fare)` and never bakes the resolution into a stored total.
 */
export const studentTransport = pgTable(
  'student_transport',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    routeId: uuid('route_id')
      .notNull()
      .references(() => transportRoutes.id, { onDelete: 'restrict' }),
    stopId: uuid('stop_id')
      .notNull()
      .references(() => routeStops.id, { onDelete: 'restrict' }),
    direction: transportDirectionEnum('direction').notNull().default('both'),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    /** Monthly fare override. Null means the stop's fare applies. Money, never a float. */
    feeOverride: numeric('fee_override', { precision: 14, scale: 2 }),
    status: transportAssignmentStatusEnum('status').notNull().default('active'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    // THE assignment invariant: at most one ACTIVE transport assignment per student.
    uniqueIndex('student_transport_student_active_key')
      .on(table.studentId)
      .where(sql`${table.status} = 'active' AND ${table.archivedAt} IS NULL`),
    index('student_transport_tenant_idx').on(table.tenantId),
    index('student_transport_student_idx').on(table.studentId, table.status),
    index('student_transport_route_idx').on(table.routeId, table.status),
    index('student_transport_stop_idx').on(table.stopId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Trips and attendance
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One run of one route's vehicle on one day, in one direction. Started and ended with
 * odometer readings so the log is auditable against fuel bills.
 *
 * `vehicle_trips_daily_key` (`(route_vehicle_id, trip_date, direction)` among live rows)
 * makes a double-started trip a database refusal, not a duplicate log entry.
 */
export const vehicleTrips = pgTable(
  'vehicle_trips',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    routeVehicleId: uuid('route_vehicle_id')
      .notNull()
      .references(() => routeVehicles.id, { onDelete: 'restrict' }),
    tripDate: date('trip_date').notNull(),
    direction: transportTripDirectionEnum('direction').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    odometerStart: integer('odometer_start').notNull(),
    odometerEnd: integer('odometer_end'),
    /** Who actually drove — defaults to the assignment's driver, recorded per trip. */
    driverId: uuid('driver_id')
      .notNull()
      .references(() => drivers.id, { onDelete: 'restrict' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('vehicle_trips_daily_key')
      .on(table.routeVehicleId, table.tripDate, table.direction)
      .where(sql`${table.archivedAt} IS NULL`),
    index('vehicle_trips_tenant_idx').on(table.tenantId),
    index('vehicle_trips_route_vehicle_idx').on(table.routeVehicleId, table.tripDate),
    index('vehicle_trips_institution_date_idx').on(table.institutionId, table.tripDate),
    index('vehicle_trips_driver_idx').on(table.driverId),
  ],
);

/**
 * Whether a student boarded, was absent, or was dropped off on one trip. One row per student
 * per trip (`trip_attendance_trip_student_key`); re-marking updates the row rather than
 * stacking contradictory records.
 */
export const tripAttendance = pgTable(
  'trip_attendance',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => vehicleTrips.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    status: transportTripAttendanceStatusEnum('status').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Where they boarded or were dropped; defaults to their assigned stop. */
    stopId: uuid('stop_id').references(() => routeStops.id, { onDelete: 'restrict' }),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    uniqueIndex('trip_attendance_trip_student_key')
      .on(table.tripId, table.studentId)
      .where(sql`${table.archivedAt} IS NULL`),
    index('trip_attendance_tenant_idx').on(table.tenantId),
    index('trip_attendance_trip_idx').on(table.tripId),
    index('trip_attendance_student_idx').on(table.studentId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────
// Maintenance
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A maintenance event — a servicing, a repair, a fitness renewal. `kind` is free text
 * because schools invent their own vocabulary; the cost is money and behaves like it.
 * `next_due_on` feeds the expiring-documents report alongside the paper expiries.
 */
export const vehicleMaintenance = pgTable(
  'vehicle_maintenance',
  {
    id: primaryKeyColumn(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'restrict' }),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'restrict' }),
    kind: varchar('kind', { length: 64 }).notNull(),
    performedOn: date('performed_on').notNull(),
    odometer: integer('odometer'),
    cost: numeric('cost', { precision: 14, scale: 2 }).notNull().default('0.00'),
    vendor: varchar('vendor', { length: 128 }),
    notes: varchar('notes', { length: 1000 }),
    nextDueOn: date('next_due_on'),
    version: versionColumn(),
    ...timestampColumns(),
    ...archiveColumns(),
    ...actorColumns(),
  },
  (table) => [
    index('vehicle_maintenance_tenant_idx').on(table.tenantId),
    index('vehicle_maintenance_vehicle_idx').on(table.vehicleId, table.performedOn),
    index('vehicle_maintenance_next_due_idx').on(table.institutionId, table.nextDueOn),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────

export const vehiclesRelations = relations(vehicles, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [vehicles.institutionId],
    references: [institutions.id],
  }),
  routeAssignments: many(routeVehicles),
  maintenanceRecords: many(vehicleMaintenance),
}));

export const driversRelations = relations(drivers, ({ one, many }) => ({
  employee: one(employees, { fields: [drivers.employeeId], references: [employees.id] }),
  routeAssignments: many(routeVehicles),
  trips: many(vehicleTrips),
}));

export const transportRoutesRelations = relations(transportRoutes, ({ one, many }) => ({
  campus: one(campuses, { fields: [transportRoutes.campusId], references: [campuses.id] }),
  shift: one(shifts, { fields: [transportRoutes.shiftId], references: [shifts.id] }),
  stops: many(routeStops),
  vehicleAssignments: many(routeVehicles),
  studentAssignments: many(studentTransport),
}));

export const routeStopsRelations = relations(routeStops, ({ one, many }) => ({
  route: one(transportRoutes, {
    fields: [routeStops.routeId],
    references: [transportRoutes.id],
  }),
  studentAssignments: many(studentTransport),
}));

export const routeVehiclesRelations = relations(routeVehicles, ({ one, many }) => ({
  route: one(transportRoutes, {
    fields: [routeVehicles.routeId],
    references: [transportRoutes.id],
  }),
  vehicle: one(vehicles, { fields: [routeVehicles.vehicleId], references: [vehicles.id] }),
  driver: one(drivers, { fields: [routeVehicles.driverId], references: [drivers.id] }),
  trips: many(vehicleTrips),
}));

export const studentTransportRelations = relations(studentTransport, ({ one }) => ({
  student: one(students, { fields: [studentTransport.studentId], references: [students.id] }),
  route: one(transportRoutes, {
    fields: [studentTransport.routeId],
    references: [transportRoutes.id],
  }),
  stop: one(routeStops, { fields: [studentTransport.stopId], references: [routeStops.id] }),
}));

export const vehicleTripsRelations = relations(vehicleTrips, ({ one, many }) => ({
  routeVehicle: one(routeVehicles, {
    fields: [vehicleTrips.routeVehicleId],
    references: [routeVehicles.id],
  }),
  driver: one(drivers, { fields: [vehicleTrips.driverId], references: [drivers.id] }),
  attendance: many(tripAttendance),
}));

export const tripAttendanceRelations = relations(tripAttendance, ({ one }) => ({
  trip: one(vehicleTrips, { fields: [tripAttendance.tripId], references: [vehicleTrips.id] }),
  student: one(students, { fields: [tripAttendance.studentId], references: [students.id] }),
  stop: one(routeStops, { fields: [tripAttendance.stopId], references: [routeStops.id] }),
}));

export const vehicleMaintenanceRelations = relations(vehicleMaintenance, ({ one }) => ({
  vehicle: one(vehicles, { fields: [vehicleMaintenance.vehicleId], references: [vehicles.id] }),
}));
