/**
 * Transport integration suite (Phase 18).
 *
 * This file holds the transport invariants, not proof that routes return 200. Each block
 * corresponds to a rule that, if it broke in production, would either put more children on a
 * bus than it has seats, show a family another family's child, or charge somebody a fare
 * nobody decided they owe:
 *
 *  - route capacity is enforced at assignment time with a clear 409, for single and bulk,
 *  - at most one ACTIVE transport assignment per student, enforced by the DATABASE — the
 *    partial unique index `student_transport_student_active_key` is asserted with a direct
 *    SQL insert that bypasses the service entirely,
 *  - at most one ACTIVE vehicle per route, again proven with a direct SQL insert against
 *    `route_vehicles_route_active_key`,
 *  - a latitude off the planet is refused by the CHECK constraint, not merely by Zod,
 *  - a guardian sees only their own child's route, stop and trip attendance, and never
 *    another route's live vehicle position (404, not 403),
 *  - the GPS stub fails loudly naming its missing credential rather than returning fake
 *    coordinates, while the mock returns clearly-labelled simulated positions,
 *  - the expiring-documents report is correct and nothing auto-suspends a vehicle,
 *  - the monthly fee schedule resolves `coalesce(fee_override, stop.fare)` as strings,
 *  - nothing is hard-deleted, and none of it crosses a tenant boundary.
 *
 * Everything runs over HTTP through the real guards, interceptors and database, because the
 * properties under test live precisely in the parts a stub would replace.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import argon2 from 'argon2';
import { addDays, todayInDhaka, uuidv7 } from '@shikkha/shared';
import {
  GPS_REQUIRED_CREDENTIALS,
  StubGpsProvider,
} from '../../src/modules/transport/providers/stub-gps.provider';
import {
  createTestApp,
  seedTenant,
  testClient,
  truncateAll,
  TEST_APP_DATABASE_URL,
  TEST_PASSWORD,
  type SeededTenant,
} from '../helpers/test-app';

describe('Transport management', () => {
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const tokens: Record<string, string> = {};

  // Ids captured as the suite builds a real fleet and fills it.
  let vehicle1Id: string; // capacity 2 — the capacity-rule subject
  let vehicle2Id: string; // serves route 2; insurance expiring soon
  let driver1Id: string;
  let driver2Id: string;
  let route1Id: string;
  let route2Id: string;
  let stopMirpurId: string; // fare 500.00
  let stopKaziparaId: string; // fare 600.00
  let stopShewraparaId: string; // fare 700.00
  let route2StopId: string; // fare 800.00
  let assignment1Id: string; // student 0 → route 1, stop Mirpur
  let tripId: string;

  const today = todayInDhaka();

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.accessToken as string;
  }

  const get = (role: string, path: string, query: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .get(path)
      .query(query)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId);

  const post = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId)
      .send(body);

  const put = (role: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${tokens[role]}`)
      .set('x-institution-id', tenantA.institutionId)
      .send(body);

  beforeAll(async () => {
    app = await createTestApp();
    await truncateAll();
    tenantA = await seedTenant('trna', { students: 4 });
    tenantB = await seedTenant('trnb', { students: 1 });

    // Simulated positions for the suite; one test flips this to prove the stub fails loudly.
    process.env['GPS_PROVIDER'] = 'mock';

    const client = testClient();
    await client.connect();
    try {
      const passwordHash = await argon2.hash(TEST_PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 8192,
        timeCost: 2,
        parallelism: 1,
      });

      // A transport manager in each tenant. The harness seeds the role but no user holding it.
      for (const [tenant, email] of [
        [tenantA, 'tmanager@trna.test'],
        [tenantB, 'tmanager@trnb.test'],
      ] as const) {
        const userId = uuidv7();
        await client.query(
          `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
           values ($1,$2,$3,$4,'Test Transport Manager','active',now())`,
          [userId, tenant.tenantId, email, passwordHash],
        );
        await client.query(
          `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
           values ($1,$2,$3,$4,$5)`,
          [
            uuidv7(),
            tenant.tenantId,
            userId,
            tenant.roleIds['transport_manager'],
            tenant.institutionId,
          ],
        );
      }
    } finally {
      await client.end();
    }

    for (const key of ['owner', 'accountant', 'teacher', 'guardian1', 'guardian2']) {
      tokens[key] = await login(tenantA.users[key]!.email);
    }
    tokens['manager'] = await login('tmanager@trna.test');
    tokens['otherManager'] = await login('tmanager@trnb.test');
  }, 120_000);

  afterAll(async () => {
    delete process.env['GPS_PROVIDER'];
    await app?.close();
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Fleet and route setup — asserting wire shapes along the way
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('fleet and route setup', () => {
    it('registers vehicles with exact expiry dates and no floats anywhere', async () => {
      const v1 = await post('manager', '/api/v1/transport/vehicles', {
        registrationNumber: 'DHK-GA-11-2233',
        model: 'Toyota Coaster',
        capacity: 2,
        fuelType: 'diesel',
        insuranceExpiry: '2030-01-01',
        fitnessExpiry: '2030-06-30',
      });
      expect(v1.status, JSON.stringify(v1.body)).toBe(201);
      expect(v1.body.status).toBe('active');
      expect(v1.body.capacity).toBe(2);
      vehicle1Id = v1.body.id;

      // Insurance expiring inside the report window; fitness far outside it.
      const v2 = await post('manager', '/api/v1/transport/vehicles', {
        registrationNumber: 'DHK-GA-11-9999',
        model: 'Hino Bus',
        capacity: 30,
        insuranceExpiry: addDays(today, 10),
        fitnessExpiry: addDays(today, 120),
      });
      expect(v2.status, JSON.stringify(v2.body)).toBe(201);
      vehicle2Id = v2.body.id;
    });

    it('refuses a duplicate registration number', async () => {
      const response = await post('manager', '/api/v1/transport/vehicles', {
        registrationNumber: 'DHK-GA-11-2233',
        capacity: 10,
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('registers drivers, one with a licence expiring inside the window', async () => {
      const d1 = await post('manager', '/api/v1/transport/drivers', {
        fullNameEn: 'Abdul Karim',
        phone: '01712345678',
        licenceNumber: 'DL-100001',
        licenceExpiry: '2030-06-30',
      });
      expect(d1.status, JSON.stringify(d1.body)).toBe(201);
      driver1Id = d1.body.id;

      const d2 = await post('manager', '/api/v1/transport/drivers', {
        fullNameEn: 'Rafiqul Islam',
        phone: '01812345678',
        licenceNumber: 'DL-100002',
        licenceExpiry: addDays(today, 5),
      });
      expect(d2.status).toBe(201);
      driver2Id = d2.body.id;

      // A licence already lapsed — the report must include it, and nothing may suspend him.
      const d3 = await post('manager', '/api/v1/transport/drivers', {
        fullNameEn: 'Expired Licence Driver',
        phone: '01912345678',
        licenceNumber: 'DL-100003',
        licenceExpiry: addDays(today, -3),
      });
      expect(d3.status).toBe(201);
      expect(d3.body.status, 'an expired licence must not auto-suspend a driver').toBe('active');
    });

    it('creates routes and replaces their stop sets with contiguous sequences', async () => {
      const r1 = await post('manager', '/api/v1/transport/routes', {
        code: 'R1',
        nameEn: 'Mirpur Route',
        nameBn: 'মিরপুর রুট',
        campusId: tenantA.campusId,
        distanceKm: '12.50',
      });
      expect(r1.status, JSON.stringify(r1.body)).toBe(201);
      route1Id = r1.body.id;

      const stops = await put('manager', `/api/v1/transport/routes/${route1Id}/stops`, {
        stops: [
          {
            nameEn: 'Mirpur 1',
            latitude: '23.8103',
            longitude: '90.4125',
            pickupTime: '06:30',
            dropTime: '13:30',
            fare: '500.00',
          },
          { nameEn: 'Kazipara', fare: '600.00' },
          { nameEn: 'Shewrapara', fare: '700.00' },
        ],
      });
      expect(stops.status, JSON.stringify(stops.body)).toBe(200);
      expect(stops.body).toHaveLength(3);
      expect(stops.body.map((stop: { sequence: number }) => stop.sequence)).toEqual([1, 2, 3]);
      // Money and coordinates are strings on the wire — numeric columns, never floats.
      expect(stops.body[0].fare).toBe('500.00');
      expect(typeof stops.body[0].latitude).toBe('string');
      expect(stops.body[0].latitude).toBe('23.810300');
      stopMirpurId = stops.body[0].id;
      stopKaziparaId = stops.body[1].id;
      stopShewraparaId = stops.body[2].id;

      const r2 = await post('manager', '/api/v1/transport/routes', {
        code: 'R2',
        nameEn: 'Uttara Route',
        campusId: tenantA.campusId,
      });
      expect(r2.status).toBe(201);
      route2Id = r2.body.id;

      const r2stops = await put('manager', `/api/v1/transport/routes/${route2Id}/stops`, {
        stops: [{ nameEn: 'Uttara Sector 4', fare: '800.00' }],
      });
      expect(r2stops.status).toBe(200);
      route2StopId = r2stops.body[0].id;
    });

    it('re-ordering the set keeps stop identities and re-derives the sequence', async () => {
      const response = await put('manager', `/api/v1/transport/routes/${route1Id}/stops`, {
        stops: [
          { id: stopKaziparaId, nameEn: 'Kazipara', fare: '600.00' },
          {
            id: stopMirpurId,
            nameEn: 'Mirpur 1',
            latitude: '23.8103',
            longitude: '90.4125',
            pickupTime: '06:30',
            dropTime: '13:30',
            fare: '500.00',
          },
          { id: stopShewraparaId, nameEn: 'Shewrapara', fare: '700.00' },
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(
        response.body.map((stop: { id: string; sequence: number }) => [stop.id, stop.sequence]),
      ).toEqual([
        [stopKaziparaId, 1],
        [stopMirpurId, 2],
        [stopShewraparaId, 3],
      ]);
    });

    it('refuses a latitude off the planet at validation', async () => {
      const response = await put('manager', `/api/v1/transport/routes/${route1Id}/stops`, {
        stops: [{ nameEn: 'Nowhere', latitude: '95', longitude: '90.4', fare: '100.00' }],
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('the DATABASE refuses a latitude off the planet, bypassing the service', async () => {
      // route_stops_latitude_range: -90..90 as a CHECK constraint on the numeric column.
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into route_stops (tenant_id, institution_id, route_id, sequence, name_en, latitude, longitude)
             values ($1,$2,$3,99,'Off the planet',95,90.4)`,
            [tenantA.tenantId, tenantA.institutionId, route1Id],
          ),
        ).rejects.toThrow(/route_stops_latitude_range/i);
      } finally {
        await client.end();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // One ACTIVE vehicle per route — a property of the database, not the service
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('single active vehicle per route', () => {
    it('assigns a vehicle and driver to each route', async () => {
      const r1 = await post('manager', `/api/v1/transport/routes/${route1Id}/vehicle`, {
        vehicleId: vehicle1Id,
        driverId: driver1Id,
        assistantName: 'Helper Bhai',
        effectiveFrom: '2026-08-01',
      });
      expect(r1.status, JSON.stringify(r1.body)).toBe(201);
      expect(r1.body.registrationNumber).toBe('DHK-GA-11-2233');
      expect(r1.body.capacity).toBe(2);
      expect(r1.body.status).toBe('active');

      const r2 = await post('manager', `/api/v1/transport/routes/${route2Id}/vehicle`, {
        vehicleId: vehicle2Id,
        driverId: driver2Id,
        effectiveFrom: '2026-08-01',
      });
      expect(r2.status).toBe(201);
    });

    it('refuses a vehicle already active on another route', async () => {
      const response = await post('manager', `/api/v1/transport/routes/${route2Id}/vehicle`, {
        vehicleId: vehicle1Id,
        driverId: driver1Id,
        effectiveFrom: '2026-08-15',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/another route/i);
    });

    it('the DATABASE refuses a second active vehicle row, bypassing the service', async () => {
      // A direct insert as the table owner — no service pre-check, no RLS. What survives is
      // the partial unique index the migration created:
      //   route_vehicles_route_active_key on (route_id) where status='active' and archived_at is null.
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into route_vehicles (tenant_id, institution_id, route_id, vehicle_id, driver_id, effective_from)
             values ($1,$2,$3,$4,$5,current_date)`,
            [tenantA.tenantId, tenantA.institutionId, route1Id, vehicle2Id, driver2Id],
          ),
        ).rejects.toThrow(/route_vehicles_route_active_key|duplicate key/i);

        // The same insert marked ended is history, not a live assignment, and is accepted —
        // proving the index is partial exactly as declared. Rolled back, leaving no trace.
        await client.query('begin');
        await client.query(
          `insert into route_vehicles (tenant_id, institution_id, route_id, vehicle_id, driver_id,
                                       effective_from, effective_to, status)
           values ($1,$2,$3,$4,$5,current_date - 30,current_date - 1,'ended')`,
          [tenantA.tenantId, tenantA.institutionId, route1Id, vehicle2Id, driver2Id],
        );
        await client.query('rollback');
      } finally {
        await client.end();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Route capacity — enforced with a clear 409, single and bulk
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('route capacity', () => {
    it('assigns students up to the active vehicle capacity', async () => {
      const first = await post('manager', '/api/v1/transport/assignments', {
        studentId: tenantA.studentIds[0],
        routeId: route1Id,
        stopId: stopMirpurId,
        direction: 'both',
        effectiveFrom: '2026-08-01',
      });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      assignment1Id = first.body.id;

      // The second student boards a different stop with a sibling discount.
      const second = await post('manager', '/api/v1/transport/assignments', {
        studentId: tenantA.studentIds[1],
        routeId: route1Id,
        stopId: stopKaziparaId,
        direction: 'both',
        effectiveFrom: '2026-08-01',
        feeOverride: '450.00',
      });
      expect(second.status, JSON.stringify(second.body)).toBe(201);
      expect(second.body.feeOverride).toBe('450.00');
    });

    it('refuses the student who would exceed the vehicle capacity, with a clear 409', async () => {
      const response = await post('manager', '/api/v1/transport/assignments', {
        studentId: tenantA.studentIds[2],
        routeId: route1Id,
        stopId: stopShewraparaId,
        direction: 'both',
        effectiveFrom: '2026-08-01',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(response.body.error.message).toMatch(/over capacity/i);
      expect(response.body.error.message).toMatch(/seats\s+2/i);
    });

    it('applies the same capacity rule to a bulk assignment, all-or-nothing', async () => {
      const response = await post('manager', '/api/v1/transport/assignments/bulk', {
        routeId: route1Id,
        stopId: stopShewraparaId,
        direction: 'pickup',
        effectiveFrom: '2026-08-01',
        studentIds: [tenantA.studentIds[2], tenantA.studentIds[3]],
      });
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/over capacity/i);

      // Nothing was written: the batch is all-or-nothing.
      const listed = await get('manager', '/api/v1/transport/assignments', {
        routeId: route1Id,
        status: 'active',
      });
      expect(listed.status).toBe(200);
      expect(listed.body.meta.total).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // One ACTIVE assignment per student — a property of the database
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('single active assignment per student', () => {
    it('the service refuses a second active assignment with a 409', async () => {
      const response = await post('manager', '/api/v1/transport/assignments', {
        studentId: tenantA.studentIds[0],
        routeId: route2Id,
        stopId: route2StopId,
        direction: 'both',
        effectiveFrom: '2026-08-15',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/active transport assignment/i);
    });

    it('the DATABASE refuses a second active assignment, bypassing the service', async () => {
      // student_transport_student_active_key on (student_id) where status='active' and
      // archived_at is null — the control that holds even when two requests race.
      const client = testClient();
      await client.connect();
      try {
        await expect(
          client.query(
            `insert into student_transport (tenant_id, institution_id, student_id, route_id, stop_id, effective_from)
             values ($1,$2,$3,$4,$5,current_date)`,
            [
              tenantA.tenantId,
              tenantA.institutionId,
              tenantA.studentIds[0],
              route2Id,
              route2StopId,
            ],
          ),
        ).rejects.toThrow(/student_transport_student_active_key|duplicate key/i);

        // An ENDED assignment for the same student is history and is accepted — the index
        // is partial on the active status, exactly as declared. Rolled back afterwards.
        await client.query('begin');
        await client.query(
          `insert into student_transport (tenant_id, institution_id, student_id, route_id, stop_id,
                                          effective_from, effective_to, status)
           values ($1,$2,$3,$4,$5,current_date - 60,current_date - 30,'ended')`,
          [tenantA.tenantId, tenantA.institutionId, tenantA.studentIds[0], route2Id, route2StopId],
        );
        await client.query('rollback');
      } finally {
        await client.end();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Trips, odometer log and attendance
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('trips and attendance', () => {
    it('starts a trip with an opening odometer reading', async () => {
      const response = await post('manager', '/api/v1/transport/trips', {
        routeId: route1Id,
        direction: 'pickup',
        odometerStart: 41200,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.odometerStart).toBe(41200);
      expect(response.body.endedAt).toBeNull();
      tripId = response.body.id;
    });

    it('refuses to start the same trip twice — vehicle_trips_daily_key stands behind it', async () => {
      const response = await post('manager', '/api/v1/transport/trips', {
        routeId: route1Id,
        direction: 'pickup',
        odometerStart: 41200,
      });
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/already been started/i);
    });

    it('marks attendance for assigned students only', async () => {
      const marked = await post('manager', `/api/v1/transport/trips/${tripId}/attendance`, {
        entries: [
          { studentId: tenantA.studentIds[0], status: 'boarded' },
          { studentId: tenantA.studentIds[1], status: 'absent' },
        ],
      });
      expect(marked.status, JSON.stringify(marked.body)).toBe(201);
      expect(marked.body.marked).toBe(2);

      // A student not on the route's manifest is a mistake, not data.
      const refused = await post('manager', `/api/v1/transport/trips/${tripId}/attendance`, {
        entries: [{ studentId: tenantA.studentIds[3], status: 'boarded' }],
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toMatch(/not actively assigned/i);
    });

    it('re-marking updates the row instead of stacking contradictory records', async () => {
      const remarked = await post('manager', `/api/v1/transport/trips/${tripId}/attendance`, {
        entries: [{ studentId: tenantA.studentIds[0], status: 'dropped' }],
      });
      expect(remarked.status).toBe(201);

      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ count: string; status: string }>(
          `select count(*)::text as count, min(status) as status
             from trip_attendance
            where trip_id = $1 and student_id = $2 and archived_at is null`,
          [tripId, tenantA.studentIds[0]],
        );
        expect(rows[0]!.count).toBe('1');
        expect(rows[0]!.status).toBe('dropped');
      } finally {
        await client.end();
      }
    });

    it('refuses a closing odometer below the opening one', async () => {
      const response = await post('manager', `/api/v1/transport/trips/${tripId}/end`, {
        odometerEnd: 41180,
        version: 1,
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('ends the trip with a sane odometer reading', async () => {
      const response = await post('manager', `/api/v1/transport/trips/${tripId}/end`, {
        odometerEnd: 41235,
        version: 1,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.endedAt).toBeTruthy();
      expect(response.body.odometerEnd).toBe(41235);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Guardian self-service: identity-scoped, no parameter to abuse
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('guardian self-service', () => {
    it('a guardian sees exactly their own child — route, stop, fare and trip attendance', async () => {
      const response = await get('guardian1', '/api/v1/transport/my-children');
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      expect(response.body.children).toHaveLength(1);
      const child = response.body.children[0];
      expect(child.student.id).toBe(tenantA.studentIds[0]);
      expect(child.assignment.routeId).toBe(route1Id);
      expect(child.assignment.stopId).toBe(stopMirpurId);
      expect(child.assignment.stopName).toBe('Mirpur 1');
      // The fare in force, money as a string.
      expect(child.assignment.monthlyFare).toBe('500.00');
      // Their child's trip attendance is visible; the final mark, not a contradiction pile.
      expect(child.tripAttendance).toHaveLength(1);
      expect(child.tripAttendance[0].status).toBe('dropped');

      // No other family's child appears anywhere in the payload.
      expect(JSON.stringify(response.body)).not.toContain(tenantA.studentIds[1]);
    });

    it('a second guardian sees only their own child, never the first family', async () => {
      const response = await get('guardian2', '/api/v1/transport/my-children');
      expect(response.status).toBe(200);
      expect(response.body.children).toHaveLength(1);
      expect(response.body.children[0].student.id).toBe(tenantA.studentIds[1]);
      // The sibling-discount override is their fare, as a string.
      expect(response.body.children[0].assignment.monthlyFare).toBe('450.00');
      expect(JSON.stringify(response.body)).not.toContain(tenantA.studentIds[0]);
    });

    it('a guardian cannot reach the staff assignment list at all', async () => {
      const response = await get('guardian1', '/api/v1/transport/assignments');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Live position: mock provider, scope rules, loud stub
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('live vehicle position', () => {
    it('a guardian sees the live position of their own child’s route (mock provider)', async () => {
      const response = await get('guardian1', `/api/v1/transport/routes/${route1Id}/live-position`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.provider).toBe('mock');
      expect(response.body.position.source).toBe('mock');
      // Coordinates are decimal strings, never floats, and are actually on the planet.
      expect(response.body.position.latitude).toMatch(/^-?\d{1,2}\.\d{6}$/);
      expect(response.body.position.longitude).toMatch(/^-?\d{1,3}\.\d{6}$/);
      expect(Number(response.body.position.latitude)).toBeGreaterThan(-90);
      expect(Number(response.body.position.latitude)).toBeLessThan(90);
    });

    it('a guardian is answered 404 — not 403 — for a route their child is not on', async () => {
      const response = await get('guardian1', `/api/v1/transport/routes/${route2Id}/live-position`);
      // Confirming the route exists (or where its bus is) is itself a leak.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('DHK-GA-11-9999');
    });

    it('staff with a manage permission may ask about any route', async () => {
      const response = await get('manager', `/api/v1/transport/routes/${route2Id}/live-position`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.registrationNumber).toBe('DHK-GA-11-9999');
    });

    it('the GPS stub fails loudly rather than returning fake coordinates', async () => {
      process.env['GPS_PROVIDER'] = 'live';
      try {
        const response = await get('manager', `/api/v1/transport/routes/${route1Id}/live-position`);
        expect(response.status).toBe(502);
        expect(response.body.error.code).toBe('EXTERNAL_SERVICE_ERROR');
        // No coordinate of any kind reaches the client from a provider that cannot answer.
        expect(JSON.stringify(response.body)).not.toContain('latitude');
      } finally {
        process.env['GPS_PROVIDER'] = 'mock';
      }
    });

    it('the stub names the missing credential in its refusal', async () => {
      const stub = new StubGpsProvider();
      // The missing variable is named in the error context, not in its message.
      // ExternalServiceError sets isPublic=false and a generic public message on purpose:
      // telling an unauthenticated caller which variable to set is information disclosure.
      // The operator gets the detail through the log; the client gets a 502 and nothing else.
      const failure = await stub
        .fetchPosition({ vehicleId: vehicle1Id, registrationNumber: 'DHK-GA-11-2233' })
        .then(
          () => null,
          (error: unknown) => error as { message: string; context: Record<string, unknown> },
        );
      expect(failure, 'the stub must refuse, never return a position').not.toBeNull();
      expect(failure!.message).toBe('The GPS tracking service is unavailable');
      // The detail lists every required variable so an operator knows the whole set.
      for (const name of GPS_REQUIRED_CREDENTIALS) {
        expect(String(failure!.context['detail'])).toContain(name);
      }
      // ...and names the first one actually missing, so the message is actionable.
      expect(GPS_REQUIRED_CREDENTIALS).toContain(failure!.context['missingCredential']);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Expiring documents: a report a human acts on, never an automatic suspension
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('expiring documents report', () => {
    it('lists exactly the documents lapsing inside the window, with days remaining', async () => {
      const response = await get('manager', '/api/v1/transport/reports/expiring-documents', {
        withinDays: 30,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const byKey = (type: string, label: RegExp) =>
        response.body.items.find(
          (item: { documentType: string; subjectLabel: string }) =>
            item.documentType === type && label.test(item.subjectLabel),
        );

      // Vehicle 2's insurance lapses in 10 days.
      const insurance = byKey('vehicle_insurance', /DHK-GA-11-9999/);
      expect(insurance, 'the expiring insurance was not reported').toBeTruthy();
      expect(insurance.daysRemaining).toBe(10);

      // Driver 2's licence lapses in 5 days; driver 3's lapsed 3 days ago.
      const licence = byKey('driver_licence', /Rafiqul Islam/);
      expect(licence).toBeTruthy();
      expect(licence.daysRemaining).toBe(5);

      const lapsed = byKey('driver_licence', /Expired Licence Driver/);
      expect(lapsed, 'an already-expired document must still be reported').toBeTruthy();
      expect(lapsed.daysRemaining).toBe(-3);
      expect(response.body.alreadyExpired).toBe(1);

      // Nothing outside the window: vehicle 1's 2030 papers and vehicle 2's fitness (120 days).
      const labels = response.body.items.map(
        (item: { subjectLabel: string; documentType: string }) =>
          `${item.documentType}:${item.subjectLabel}`,
      );
      expect(labels.some((label: string) => label.includes('DHK-GA-11-2233'))).toBe(false);
      expect(
        labels.some((label: string) => label.startsWith('vehicle_fitness:DHK-GA-11-9999')),
      ).toBe(false);
    });

    it('nothing auto-suspended the vehicle or driver whose papers lapse', async () => {
      const vehicle = await get('manager', `/api/v1/transport/vehicles/${vehicle2Id}`);
      expect(vehicle.status).toBe(200);
      expect(vehicle.body.status, 'expiry must not change a vehicle status by itself').toBe(
        'active',
      );
    });

    it('the report is refused to roles without fleet authority — licences are personal data', async () => {
      const guardian = await get('guardian1', '/api/v1/transport/reports/expiring-documents');
      expect(guardian.status).toBe(403);

      const teacher = await get('teacher', '/api/v1/transport/reports/expiring-documents');
      expect(teacher.status).toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Occupancy and the monthly fee schedule
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('occupancy and fees', () => {
    it('reports seats versus assignments per route', async () => {
      const response = await get('manager', '/api/v1/transport/reports/occupancy');
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const r1 = response.body.rows.find((row: { routeCode: string }) => row.routeCode === 'R1');
      expect(r1.capacity).toBe(2);
      expect(r1.assignedStudents).toBe(2);
      expect(r1.seatsAvailable).toBe(0);

      const r2 = response.body.rows.find((row: { routeCode: string }) => row.routeCode === 'R2');
      expect(r2.capacity).toBe(30);
      expect(r2.assignedStudents).toBe(0);
    });

    it('produces the monthly fee schedule with overrides resolved, money as strings', async () => {
      // The accountant reaches it through finance.invoices.generate — the fees module's
      // side of the integration — without holding any transport permission.
      const response = await get('accountant', '/api/v1/transport/reports/fee-schedule', {
        month: '2026-09',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.periodStart).toBe('2026-09-01');
      expect(response.body.periodEnd).toBe('2026-09-30');
      expect(response.body.studentCount).toBe(2);

      const rows = response.body.rows as Array<{
        studentId: string;
        monthlyFare: string;
        stopName: string;
      }>;
      const student0 = rows.find((row) => row.studentId === tenantA.studentIds[0]);
      const student1 = rows.find((row) => row.studentId === tenantA.studentIds[1]);
      // The stop fare for one, the override for the other — resolved, never stored.
      expect(student0!.monthlyFare).toBe('500.00');
      expect(student1!.monthlyFare).toBe('450.00');
      expect(response.body.totalMonthlyFares).toBe('950.00');
    });

    it('the fee schedule is refused to a teacher', async () => {
      const response = await get('teacher', '/api/v1/transport/reports/fee-schedule', {
        month: '2026-09',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Nothing is hard-deleted
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('no hard deletes', () => {
    let vehicle3Id: string;

    it('archiving requires a written reason', async () => {
      const v3 = await post('manager', '/api/v1/transport/vehicles', {
        registrationNumber: 'DHK-GA-11-7777',
        capacity: 12,
      });
      expect(v3.status).toBe(201);
      vehicle3Id = v3.body.id;

      const response = await post(
        'manager',
        `/api/v1/transport/vehicles/${vehicle3Id}/archive`,
        {},
      );
      expect(response.status).toBe(422);
    });

    it('a vehicle on an active route cannot be retired out from under it', async () => {
      const response = await post('manager', `/api/v1/transport/vehicles/${vehicle2Id}/archive`, {
        reason: 'Attempting to retire a bus that is still serving route R2',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/assigned to a route/i);
    });

    it('retirement archives the row — it never leaves the register', async () => {
      const response = await post('manager', `/api/v1/transport/vehicles/${vehicle3Id}/archive`, {
        reason: 'Sold at auction after the fitness certificate lapsed twice',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('retired');
      expect(response.body.archivedAt).toBeTruthy();
      expect(response.body.archiveReason).toMatch(/auction/i);

      // Gone from the default list…
      const listed = await get('manager', '/api/v1/transport/vehicles', { pageSize: 50 });
      expect(listed.body.data.some((row: { id: string }) => row.id === vehicle3Id)).toBe(false);

      // …but still in the database, with its history.
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query(
          `select archived_at, archive_reason from vehicles where id = $1`,
          [vehicle3Id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].archived_at).toBeTruthy();
      } finally {
        await client.end();
      }
    });

    it('an ended student assignment stays as history', async () => {
      const response = await post('manager', `/api/v1/transport/assignments/${assignment1Id}/end`, {
        effectiveTo: '2026-12-31',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.status).toBe('ended');
      expect(response.body.effectiveTo).toBe('2026-12-31');

      const listed = await get('manager', '/api/v1/transport/assignments', {
        studentId: tenantA.studentIds[0],
      });
      expect(listed.body.meta.total, 'the ended assignment must remain readable').toBe(1);
      expect(listed.body.data[0].status).toBe('ended');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Permission denials
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('permission enforcement', () => {
    it('refuses fleet writes to a role with no transport authority', async () => {
      const response = await post('teacher', '/api/v1/transport/vehicles', {
        registrationNumber: 'SNEAK-1',
        capacity: 4,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      // The refusal does not name the permission it was short of.
      expect(JSON.stringify(response.body)).not.toContain('transport.vehicles.manage');
    });

    it('view access does not extend to assigning students', async () => {
      // The guardian preset holds transport.view and nothing else in the module.
      const browse = await get('guardian1', '/api/v1/transport/routes');
      expect(browse.status).toBe(200);

      const assign = await post('guardian1', '/api/v1/transport/assignments', {
        studentId: tenantA.studentIds[0],
        routeId: route2Id,
        stopId: route2StopId,
        direction: 'both',
        effectiveFrom: '2026-09-01',
      });
      expect(assign.status).toBe(403);
      expect(assign.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ══════════════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('another tenant cannot read a route by its exact id — 404, never 403', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/transport/routes/${route1Id}`)
        .set('Authorization', `Bearer ${tokens['otherManager']}`)
        .set('x-institution-id', tenantB.institutionId);

      // 404, not 403: confirming the record exists elsewhere is itself a leak.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('Mirpur');
    });

    it('another tenant cannot borrow the institution header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/transport/routes')
        .set('Authorization', `Bearer ${tokens['otherManager']}`)
        .set('x-institution-id', tenantA.institutionId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('another tenant’s fleet is empty rather than leaky', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/transport/vehicles')
        .set('Authorization', `Bearer ${tokens['otherManager']}`)
        .set('x-institution-id', tenantB.institutionId);

      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('every transport table carries forced row-level security', async () => {
      const client = testClient();
      await client.connect();
      try {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relkind = 'r'
              and c.relname in ('vehicles','drivers','transport_routes','route_stops',
                                'route_vehicles','student_transport','vehicle_trips',
                                'trip_attendance','vehicle_maintenance')
              and (not c.relrowsecurity
                   or not c.relforcerowsecurity
                   or not exists (select 1 from pg_policy p
                                   where p.polrelid = c.oid and p.polname = 'tenant_isolation'))`,
        );
        expect(rows.map((row) => row.relname)).toEqual([]);
      } finally {
        await client.end();
      }
    });

    it('the database refuses a route stamped with another tenant’s id', async () => {
      // Connects as `shikkha_app` — the same unprivileged role the API uses — so this is what
      // an attacker with SQL execution inside the application would actually be able to do.
      const client = new Client({ connectionString: TEST_APP_DATABASE_URL });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
        await expect(
          client.query(
            `insert into transport_routes (tenant_id, institution_id, campus_id, code, name_en)
             values ($1,$2,$3,'EVIL','Cross-tenant write attempt')`,
            [tenantA.tenantId, tenantA.institutionId, tenantA.campusId],
          ),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.end();
      }
    });
  });
});
