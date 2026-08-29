/**
 * Transport schemas (Phase 18).
 *
 * The rules that shape everything here, inherited from the fees module:
 *
 *  - **Money crosses the wire as a decimal string, never a number** (ADR-004). A stop's
 *    fare, a fee override and a maintenance cost all use the non-negative money pattern.
 *  - **Coordinates cross the wire as decimal strings too.** They are `numeric(9, 6)` in the
 *    database; parsing them into a float anywhere between the form and the column would
 *    quietly corrupt the sixth decimal place. The range check (-90..90, -180..180) is
 *    applied here for a friendly message and restated as a CHECK constraint in the database.
 *  - **A client never states a derived fact.** There is no `status` on an assignment input,
 *    no `sequence` on a stop (the array order is the sequence), and no computed fare total
 *    anywhere.
 *
 * Every exported constant carries the `TRANSPORT_` prefix because `@shikkha/validation`
 * re-exports flat.
 */

import { z } from 'zod';
import {
  bdPhoneSchema,
  calendarDateSchema,
  paginationSchema,
  positiveMoneySchema,
  reasonSchema,
  searchSchema,
  sortSchema,
  uuidSchema,
} from './common';

const code = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only')
    .min(1)
    .max(max);

/** HH:mm, optionally HH:mm:ss — what a `time` column accepts. */
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use the format HH:mm');

/**
 * A coordinate as a decimal string with at most six decimal places — the exact shape of the
 * `numeric(9, 6)` column. `Number` is used only to range-check, never to store.
 */
const coordinate = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^-?\d{1,3}(\.\d{1,6})?$/, 'Use a decimal with at most six decimal places')
    .superRefine((value, ctx) => {
      const parsed = Number(value);
      if (parsed < min || parsed > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Must be between ${min} and ${max}`,
        });
      }
    });

const latitudeSchema = coordinate(-90, 90);
const longitudeSchema = coordinate(-180, 180);

/** Kilometres with at most two decimal places. Exact, like the `numeric(8, 2)` column. */
const distanceKmSchema = z
  .string()
  .trim()
  .regex(/^\d{1,6}(\.\d{1,2})?$/, 'Use kilometres with at most two decimal places');

// ── Value sets, mirrored from the database enums ─────────────────────────────────────

export const TRANSPORT_VEHICLE_STATUSES = ['active', 'maintenance', 'retired'] as const;

export const TRANSPORT_FUEL_TYPES = [
  'diesel',
  'petrol',
  'octane',
  'cng',
  'lpg',
  'electric',
  'other',
] as const;

export const TRANSPORT_DRIVER_STATUSES = ['active', 'inactive'] as const;

export const TRANSPORT_ASSIGNMENT_STATUSES = ['active', 'ended'] as const;

export const TRANSPORT_DIRECTIONS = ['pickup', 'drop', 'both'] as const;

export const TRANSPORT_TRIP_DIRECTIONS = ['pickup', 'drop'] as const;

export const TRANSPORT_TRIP_ATTENDANCE_STATUSES = ['boarded', 'absent', 'dropped'] as const;

/** `'active' | 'inactive'` — a varchar union in the schema, not a pgEnum. */
export const TRANSPORT_ROUTE_STATUSES = ['active', 'inactive'] as const;

// ── Sort-field allow-lists ───────────────────────────────────────────────────────────

export const TRANSPORT_VEHICLE_SORT_FIELDS = [
  'registrationNumber',
  'capacity',
  'status',
  'insuranceExpiry',
  'fitnessExpiry',
  'createdAt',
] as const;

export const TRANSPORT_DRIVER_SORT_FIELDS = [
  'fullNameEn',
  'licenceExpiry',
  'status',
  'createdAt',
] as const;

export const TRANSPORT_ROUTE_SORT_FIELDS = ['code', 'nameEn', 'status', 'createdAt'] as const;

export const TRANSPORT_ASSIGNMENT_SORT_FIELDS = ['effectiveFrom', 'status', 'createdAt'] as const;

export const TRANSPORT_TRIP_SORT_FIELDS = ['tripDate', 'startedAt', 'createdAt'] as const;

// ── Vehicles ─────────────────────────────────────────────────────────────────────────

export const createTransportVehicleSchema = z.object({
  /** The BRTA plate, e.g. "DHAKA-METRO-GA-11-2233". */
  registrationNumber: z.string().trim().min(2).max(32),
  model: z.string().trim().max(128).optional(),
  capacity: z.coerce.number().int().min(1).max(200),
  fuelType: z.enum(TRANSPORT_FUEL_TYPES).default('diesel'),
  insuranceExpiry: calendarDateSchema.optional(),
  fitnessExpiry: calendarDateSchema.optional(),
  notes: z.string().trim().max(1000).optional(),
});

export type CreateTransportVehicleInput = z.infer<typeof createTransportVehicleSchema>;

export const updateTransportVehicleSchema = z
  .object({
    registrationNumber: z.string().trim().min(2).max(32).optional(),
    model: z.string().trim().max(128).nullable().optional(),
    capacity: z.coerce.number().int().min(1).max(200).optional(),
    fuelType: z.enum(TRANSPORT_FUEL_TYPES).optional(),
    insuranceExpiry: calendarDateSchema.nullable().optional(),
    fitnessExpiry: calendarDateSchema.nullable().optional(),
    /** A human moves a vehicle to `maintenance` or `retired`; nothing does it automatically. */
    status: z.enum(TRANSPORT_VEHICLE_STATUSES).optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    /** Optimistic lock. Rejecting a stale write beats silently overwriting a colleague. */
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateTransportVehicleInput = z.infer<typeof updateTransportVehicleSchema>;

export const listTransportVehiclesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    status: z.enum(TRANSPORT_VEHICLE_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

export const transportArchiveSchema = z.object({ reason: reasonSchema });

// ── Drivers ──────────────────────────────────────────────────────────────────────────

export const createTransportDriverSchema = z.object({
  /** Optional link to an HR record; contracted drivers legitimately have none. */
  employeeId: uuidSchema.optional(),
  fullNameEn: z.string().trim().min(2).max(255),
  fullNameBn: z.string().trim().max(255).optional(),
  phone: bdPhoneSchema,
  licenceNumber: z.string().trim().min(2).max(64),
  licenceExpiry: calendarDateSchema,
});

export type CreateTransportDriverInput = z.infer<typeof createTransportDriverSchema>;

export const updateTransportDriverSchema = z
  .object({
    employeeId: uuidSchema.nullable().optional(),
    fullNameEn: z.string().trim().min(2).max(255).optional(),
    fullNameBn: z.string().trim().max(255).nullable().optional(),
    phone: bdPhoneSchema.optional(),
    licenceNumber: z.string().trim().min(2).max(64).optional(),
    licenceExpiry: calendarDateSchema.optional(),
    status: z.enum(TRANSPORT_DRIVER_STATUSES).optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateTransportDriverInput = z.infer<typeof updateTransportDriverSchema>;

export const listTransportDriversSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    status: z.enum(TRANSPORT_DRIVER_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Routes ───────────────────────────────────────────────────────────────────────────

export const createTransportRouteSchema = z.object({
  code: code(32),
  nameEn: z.string().trim().min(1).max(128),
  nameBn: z.string().trim().max(128).optional(),
  campusId: uuidSchema,
  shiftId: uuidSchema.optional(),
  distanceKm: distanceKmSchema.optional(),
});

export type CreateTransportRouteInput = z.infer<typeof createTransportRouteSchema>;

export const updateTransportRouteSchema = z
  .object({
    code: code(32).optional(),
    nameEn: z.string().trim().min(1).max(128).optional(),
    nameBn: z.string().trim().max(128).nullable().optional(),
    campusId: uuidSchema.optional(),
    shiftId: uuidSchema.nullable().optional(),
    distanceKm: distanceKmSchema.nullable().optional(),
    /** `inactive` stops new assignments and trips; existing history stays. */
    status: z.enum(TRANSPORT_ROUTE_STATUSES).optional(),
    version: z.number().int().min(1),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'No changes were submitted',
  });

export type UpdateTransportRouteInput = z.infer<typeof updateTransportRouteSchema>;

export const listTransportRoutesSchema = paginationSchema
  .merge(sortSchema)
  .merge(searchSchema)
  .extend({
    campusId: uuidSchema.optional(),
    status: z.enum(TRANSPORT_ROUTE_STATUSES).optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

// ── Stops: replaced as a set ─────────────────────────────────────────────────────────

/**
 * One stop in the replacement set. `id` names an existing stop to keep (so the student
 * assignments pointing at it survive the replace); a stop without an id is created. The
 * array order *is* the sequence — a client cannot submit a non-contiguous one.
 */
const transportStopInputSchema = z
  .object({
    id: uuidSchema.optional(),
    nameEn: z.string().trim().min(1).max(128),
    nameBn: z.string().trim().max(128).optional(),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
    pickupTime: timeOfDay.optional(),
    dropTime: timeOfDay.optional(),
    /** Monthly fare for boarding at this stop. Non-negative money as a decimal string. */
    fare: positiveMoneySchema.default('0.00'),
  })
  .refine((data) => (data.latitude === undefined) === (data.longitude === undefined), {
    message: 'Give both coordinates or neither',
    path: ['longitude'],
  });

export const putTransportRouteStopsSchema = z
  .object({
    stops: z.array(transportStopInputSchema).min(1).max(100),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (const [index, stop] of data.stops.entries()) {
      if (stop.id) {
        if (seen.has(stop.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['stops', index, 'id'],
            message: 'The same stop appears twice in the set',
          });
        }
        seen.add(stop.id);
      }
    }
  });

export type PutTransportRouteStopsInput = z.infer<typeof putTransportRouteStopsSchema>;

// ── Vehicle assignment ───────────────────────────────────────────────────────────────

/**
 * Put a vehicle (and driver) on a route. The service ends any current active assignment in
 * the same transaction; the partial unique index `route_vehicles_route_active_key` is the
 * guarantee that no route ever carries two.
 */
export const assignTransportVehicleSchema = z.object({
  vehicleId: uuidSchema,
  driverId: uuidSchema,
  assistantName: z.string().trim().max(128).optional(),
  effectiveFrom: calendarDateSchema,
});

export type AssignTransportVehicleInput = z.infer<typeof assignTransportVehicleSchema>;

export const endTransportVehicleAssignmentSchema = z.object({
  effectiveTo: calendarDateSchema,
});

export type EndTransportVehicleAssignmentInput = z.infer<
  typeof endTransportVehicleAssignmentSchema
>;

// ── Student assignment ───────────────────────────────────────────────────────────────

export const assignStudentTransportSchema = z.object({
  studentId: uuidSchema,
  routeId: uuidSchema,
  stopId: uuidSchema,
  direction: z.enum(TRANSPORT_DIRECTIONS).default('both'),
  effectiveFrom: calendarDateSchema,
  /** Monthly fare override for this student. Omit to charge the stop's fare. */
  feeOverride: positiveMoneySchema.optional(),
});

export type AssignStudentTransportInput = z.infer<typeof assignStudentTransportSchema>;

/** The bulk form: one route, one stop, many students, all-or-nothing. */
export const bulkAssignStudentTransportSchema = z.object({
  routeId: uuidSchema,
  stopId: uuidSchema,
  direction: z.enum(TRANSPORT_DIRECTIONS).default('both'),
  effectiveFrom: calendarDateSchema,
  feeOverride: positiveMoneySchema.optional(),
  studentIds: z.array(uuidSchema).min(1).max(200),
});

export type BulkAssignStudentTransportInput = z.infer<typeof bulkAssignStudentTransportSchema>;

export const endStudentTransportSchema = z.object({
  effectiveTo: calendarDateSchema,
});

export type EndStudentTransportInput = z.infer<typeof endStudentTransportSchema>;

export const listStudentTransportSchema = paginationSchema.merge(sortSchema).extend({
  routeId: uuidSchema.optional(),
  stopId: uuidSchema.optional(),
  studentId: uuidSchema.optional(),
  status: z.enum(TRANSPORT_ASSIGNMENT_STATUSES).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// ── Trips ────────────────────────────────────────────────────────────────────────────

export const startVehicleTripSchema = z.object({
  routeId: uuidSchema,
  direction: z.enum(TRANSPORT_TRIP_DIRECTIONS),
  /** Defaults to today in Dhaka. */
  tripDate: calendarDateSchema.optional(),
  odometerStart: z.coerce.number().int().min(0).max(10_000_000),
  /** Omit to record the assignment's regular driver. */
  driverId: uuidSchema.optional(),
});

export type StartVehicleTripInput = z.infer<typeof startVehicleTripSchema>;

export const endVehicleTripSchema = z.object({
  odometerEnd: z.coerce.number().int().min(0).max(10_000_000),
  version: z.number().int().min(1),
});

export type EndVehicleTripInput = z.infer<typeof endVehicleTripSchema>;

export const listVehicleTripsSchema = paginationSchema.merge(sortSchema).extend({
  routeId: uuidSchema.optional(),
  tripDate: calendarDateSchema.optional(),
  direction: z.enum(TRANSPORT_TRIP_DIRECTIONS).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

/** Re-marking a student on the same trip updates their row rather than stacking rows. */
export const markTripAttendanceSchema = z.object({
  entries: z
    .array(
      z.object({
        studentId: uuidSchema,
        status: z.enum(TRANSPORT_TRIP_ATTENDANCE_STATUSES),
        /** Where they actually boarded, when it differs from their assigned stop. */
        stopId: uuidSchema.optional(),
      }),
    )
    .min(1)
    .max(200),
});

export type MarkTripAttendanceInput = z.infer<typeof markTripAttendanceSchema>;

// ── Maintenance ──────────────────────────────────────────────────────────────────────

export const createVehicleMaintenanceSchema = z.object({
  vehicleId: uuidSchema,
  /** Free text — "servicing", "fitness renewal", "seat repair". Not an enum by design. */
  kind: z.string().trim().min(2).max(64),
  performedOn: calendarDateSchema,
  odometer: z.coerce.number().int().min(0).max(10_000_000).optional(),
  cost: positiveMoneySchema.default('0.00'),
  vendor: z.string().trim().max(128).optional(),
  notes: z.string().trim().max(1000).optional(),
  nextDueOn: calendarDateSchema.optional(),
});

export type CreateVehicleMaintenanceInput = z.infer<typeof createVehicleMaintenanceSchema>;

export const listVehicleMaintenanceSchema = paginationSchema.merge(sortSchema).extend({
  vehicleId: uuidSchema.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

// ── Reports ──────────────────────────────────────────────────────────────────────────

export const transportExpiringDocumentsQuerySchema = z.object({
  /** How far ahead to look. Already-expired documents are always included. */
  withinDays: z.coerce.number().int().min(1).max(365).default(30),
});

/**
 * The month a billing period covers, e.g. `2026-09`. The fee schedule reports every student
 * actively assigned during that month and the monthly fare each one owes.
 */
export const transportFeeScheduleQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM'),
});

export type TransportFeeScheduleQuery = z.infer<typeof transportFeeScheduleQuerySchema>;
