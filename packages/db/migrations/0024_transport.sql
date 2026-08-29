-- =====================================================================================
-- 0024 — Transport (Phase 18)
--
-- Nine tenant-scoped tables covering the fleet, routes and stops, vehicle and student
-- assignments, trips with odometer logs, per-trip attendance, and maintenance history.
-- Four properties are enforced here rather than left to the application, because each is a
-- property the application can only get wrong once:
--
--   1. **At most one ACTIVE vehicle per route.** `route_vehicles_route_active_key` is a
--      partial unique index on `(route_id) where status = 'active' and archived_at is null`.
--      Two clerks assigning replacement buses at the same moment collide in Postgres — a
--      unique violation surfaced as a 409 — not in an application check a race can slip past.
--   2. **At most one ACTIVE transport assignment per student.**
--      `student_transport_student_active_key`, same construction, on `(student_id)`.
--   3. **Coordinates are numeric and on the planet.** `numeric(9, 6)`, with CHECK
--      constraints holding latitude to -90..90 and longitude to -180..180. No float, ever.
--   4. **No floating point money.** Every monetary column (`route_stops.fare`,
--      `student_transport.fee_override`, `vehicle_maintenance.cost`) is `numeric(14, 2)`;
--      the driver returns it as a string and `Money` is the only parser (ADR-004).
--
-- Expiry dates (vehicle insurance and fitness, driver licence) feed a report; nothing in
-- this schema or any trigger suspends a vehicle automatically — a human acts on the report.
--
-- Row-level security is applied at the bottom with the same `tenant_isolation` policy every
-- other tenant table carries. The driving loop in 0002 does not re-run for tables created
-- later, so the policy, grants and `set_updated_at` trigger are applied here explicitly, and
-- `assert_rls_coverage()` is called last so a mistake fails the migration rather than
-- shipping a silently-disabled control.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Enumerations. Closed value sets — a new trip direction changes trip code as well as the
-- schema. A school's own maintenance *kinds* are free text, not values here. All names carry
-- the `transport_` prefix so collision with another module is impossible.
-- -------------------------------------------------------------------------------------

create type public.transport_vehicle_status as enum ('active', 'maintenance', 'retired');

create type public.transport_fuel_type as enum (
  'diesel', 'petrol', 'octane', 'cng', 'lpg', 'electric', 'other'
);

create type public.transport_driver_status as enum ('active', 'inactive');

create type public.transport_assignment_status as enum ('active', 'ended');

create type public.transport_direction as enum ('pickup', 'drop', 'both');

create type public.transport_trip_direction as enum ('pickup', 'drop');

create type public.transport_trip_attendance_status as enum ('boarded', 'absent', 'dropped');

-- -------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------

create table public.vehicles (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  registration_number varchar(32) not null,
  model varchar(128),
  capacity smallint not null,
  fuel_type public.transport_fuel_type default 'diesel' not null,
  insurance_expiry date,
  fitness_expiry date,
  status public.transport_vehicle_status default 'active' not null,
  notes varchar(1000),
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.drivers (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  employee_id uuid,
  full_name_en varchar(255) not null,
  full_name_bn varchar(255),
  phone varchar(20) not null,
  licence_number varchar(64) not null,
  licence_expiry date not null,
  status public.transport_driver_status default 'active' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.transport_routes (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  campus_id uuid not null,
  code varchar(32) not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  shift_id uuid,
  distance_km numeric(8, 2),
  status varchar(16) default 'active' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.route_stops (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  route_id uuid not null,
  sequence smallint not null,
  name_en varchar(128) not null,
  name_bn varchar(128),
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  pickup_time time,
  drop_time time,
  fare numeric(14, 2) default '0.00' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.route_vehicles (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  route_id uuid not null,
  vehicle_id uuid not null,
  driver_id uuid not null,
  assistant_name varchar(128),
  effective_from date not null,
  effective_to date,
  status public.transport_assignment_status default 'active' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.student_transport (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  student_id uuid not null,
  route_id uuid not null,
  stop_id uuid not null,
  direction public.transport_direction default 'both' not null,
  effective_from date not null,
  effective_to date,
  fee_override numeric(14, 2),
  status public.transport_assignment_status default 'active' not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.vehicle_trips (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  route_vehicle_id uuid not null,
  trip_date date not null,
  direction public.transport_trip_direction not null,
  started_at timestamp with time zone not null,
  ended_at timestamp with time zone,
  odometer_start integer not null,
  odometer_end integer,
  driver_id uuid not null,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.trip_attendance (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  trip_id uuid not null,
  student_id uuid not null,
  status public.transport_trip_attendance_status not null,
  recorded_at timestamp with time zone default now() not null,
  stop_id uuid,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

create table public.vehicle_maintenance (
  id uuid primary key default gen_random_uuid() not null,
  tenant_id uuid not null,
  institution_id uuid not null,
  vehicle_id uuid not null,
  kind varchar(64) not null,
  performed_on date not null,
  odometer integer,
  cost numeric(14, 2) default '0.00' not null,
  vendor varchar(128),
  notes varchar(1000),
  next_due_on date,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  archived_at timestamp with time zone,
  archived_by uuid,
  archive_reason varchar(500),
  created_by uuid,
  updated_by uuid
);

-- -------------------------------------------------------------------------------------
-- Foreign keys. `restrict` throughout: a vehicle with trips, a stop with student
-- assignments, a trip with attendance and a driver with history must never be removable.
-- Nothing here is owned-and-cascaded — every row is an institutional record in its own right.
-- -------------------------------------------------------------------------------------

alter table public.vehicles
  add constraint vehicles_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint vehicles_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict;

alter table public.drivers
  add constraint drivers_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint drivers_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint drivers_employee_id_employees_id_fk
    foreign key (employee_id) references public.employees(id) on delete restrict;

alter table public.transport_routes
  add constraint transport_routes_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint transport_routes_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint transport_routes_campus_id_campuses_id_fk
    foreign key (campus_id) references public.campuses(id) on delete restrict,
  add constraint transport_routes_shift_id_shifts_id_fk
    foreign key (shift_id) references public.shifts(id) on delete restrict;

alter table public.route_stops
  add constraint route_stops_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint route_stops_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint route_stops_route_id_transport_routes_id_fk
    foreign key (route_id) references public.transport_routes(id) on delete restrict;

alter table public.route_vehicles
  add constraint route_vehicles_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint route_vehicles_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint route_vehicles_route_id_transport_routes_id_fk
    foreign key (route_id) references public.transport_routes(id) on delete restrict,
  add constraint route_vehicles_vehicle_id_vehicles_id_fk
    foreign key (vehicle_id) references public.vehicles(id) on delete restrict,
  add constraint route_vehicles_driver_id_drivers_id_fk
    foreign key (driver_id) references public.drivers(id) on delete restrict;

alter table public.student_transport
  add constraint student_transport_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint student_transport_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint student_transport_student_id_students_id_fk
    foreign key (student_id) references public.students(id) on delete restrict,
  add constraint student_transport_route_id_transport_routes_id_fk
    foreign key (route_id) references public.transport_routes(id) on delete restrict,
  add constraint student_transport_stop_id_route_stops_id_fk
    foreign key (stop_id) references public.route_stops(id) on delete restrict;

alter table public.vehicle_trips
  add constraint vehicle_trips_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint vehicle_trips_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint vehicle_trips_route_vehicle_id_route_vehicles_id_fk
    foreign key (route_vehicle_id) references public.route_vehicles(id) on delete restrict,
  add constraint vehicle_trips_driver_id_drivers_id_fk
    foreign key (driver_id) references public.drivers(id) on delete restrict;

alter table public.trip_attendance
  add constraint trip_attendance_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint trip_attendance_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint trip_attendance_trip_id_vehicle_trips_id_fk
    foreign key (trip_id) references public.vehicle_trips(id) on delete restrict,
  add constraint trip_attendance_student_id_students_id_fk
    foreign key (student_id) references public.students(id) on delete restrict,
  add constraint trip_attendance_stop_id_route_stops_id_fk
    foreign key (stop_id) references public.route_stops(id) on delete restrict;

alter table public.vehicle_maintenance
  add constraint vehicle_maintenance_tenant_id_organizations_id_fk
    foreign key (tenant_id) references public.organizations(id) on delete restrict,
  add constraint vehicle_maintenance_institution_id_institutions_id_fk
    foreign key (institution_id) references public.institutions(id) on delete restrict,
  add constraint vehicle_maintenance_vehicle_id_vehicles_id_fk
    foreign key (vehicle_id) references public.vehicles(id) on delete restrict;

-- -------------------------------------------------------------------------------------
-- Indexes. The mandatory `<table>_tenant_idx` on every table; uniqueness on business keys is
-- partial on `archived_at is null` (ADR-008), so a retired vehicle's registration plate and
-- an archived route's code stay in the record while remaining reusable.
-- -------------------------------------------------------------------------------------

create unique index if not exists vehicles_institution_registration_key
  on public.vehicles using btree (institution_id, registration_number)
  where archived_at is null;
create index if not exists vehicles_tenant_idx
  on public.vehicles using btree (tenant_id);
create index if not exists vehicles_institution_status_idx
  on public.vehicles using btree (institution_id, status);

create unique index if not exists drivers_institution_licence_key
  on public.drivers using btree (institution_id, licence_number)
  where archived_at is null;
create unique index if not exists drivers_employee_key
  on public.drivers using btree (employee_id)
  where employee_id is not null and archived_at is null;
create index if not exists drivers_tenant_idx
  on public.drivers using btree (tenant_id);
create index if not exists drivers_institution_status_idx
  on public.drivers using btree (institution_id, status);

create unique index if not exists transport_routes_institution_code_key
  on public.transport_routes using btree (institution_id, code)
  where archived_at is null;
create index if not exists transport_routes_tenant_idx
  on public.transport_routes using btree (tenant_id);
create index if not exists transport_routes_institution_status_idx
  on public.transport_routes using btree (institution_id, status);
create index if not exists transport_routes_campus_idx
  on public.transport_routes using btree (campus_id);
create index if not exists transport_routes_shift_idx
  on public.transport_routes using btree (shift_id);

create unique index if not exists route_stops_route_sequence_key
  on public.route_stops using btree (route_id, sequence)
  where archived_at is null;
create index if not exists route_stops_tenant_idx
  on public.route_stops using btree (tenant_id);
create index if not exists route_stops_route_idx
  on public.route_stops using btree (route_id, sequence);

-- THE fleet-assignment control: at most one ACTIVE vehicle per route, guaranteed by
-- Postgres. Ending the current assignment and creating its replacement happens in one
-- transaction; a concurrent double-assign collides here rather than in a service check.
create unique index if not exists route_vehicles_route_active_key
  on public.route_vehicles using btree (route_id)
  where status = 'active' and archived_at is null;

create index if not exists route_vehicles_tenant_idx
  on public.route_vehicles using btree (tenant_id);
create index if not exists route_vehicles_route_idx
  on public.route_vehicles using btree (route_id, status);
create index if not exists route_vehicles_vehicle_idx
  on public.route_vehicles using btree (vehicle_id, status);
create index if not exists route_vehicles_driver_idx
  on public.route_vehicles using btree (driver_id);

-- THE student-assignment control: at most one ACTIVE transport assignment per student.
create unique index if not exists student_transport_student_active_key
  on public.student_transport using btree (student_id)
  where status = 'active' and archived_at is null;

create index if not exists student_transport_tenant_idx
  on public.student_transport using btree (tenant_id);
create index if not exists student_transport_student_idx
  on public.student_transport using btree (student_id, status);
create index if not exists student_transport_route_idx
  on public.student_transport using btree (route_id, status);
create index if not exists student_transport_stop_idx
  on public.student_transport using btree (stop_id);

-- One trip per assignment per day per direction: a double-started trip is a database
-- refusal, not a duplicate log entry.
create unique index if not exists vehicle_trips_daily_key
  on public.vehicle_trips using btree (route_vehicle_id, trip_date, direction)
  where archived_at is null;
create index if not exists vehicle_trips_tenant_idx
  on public.vehicle_trips using btree (tenant_id);
create index if not exists vehicle_trips_route_vehicle_idx
  on public.vehicle_trips using btree (route_vehicle_id, trip_date);
create index if not exists vehicle_trips_institution_date_idx
  on public.vehicle_trips using btree (institution_id, trip_date);
create index if not exists vehicle_trips_driver_idx
  on public.vehicle_trips using btree (driver_id);

create unique index if not exists trip_attendance_trip_student_key
  on public.trip_attendance using btree (trip_id, student_id)
  where archived_at is null;
create index if not exists trip_attendance_tenant_idx
  on public.trip_attendance using btree (tenant_id);
create index if not exists trip_attendance_trip_idx
  on public.trip_attendance using btree (trip_id);
create index if not exists trip_attendance_student_idx
  on public.trip_attendance using btree (student_id);

create index if not exists vehicle_maintenance_tenant_idx
  on public.vehicle_maintenance using btree (tenant_id);
create index if not exists vehicle_maintenance_vehicle_idx
  on public.vehicle_maintenance using btree (vehicle_id, performed_on);
create index if not exists vehicle_maintenance_next_due_idx
  on public.vehicle_maintenance using btree (institution_id, next_due_on);

-- -------------------------------------------------------------------------------------
-- Data-integrity constraints that belong in the database, not only in a Zod schema. The
-- geographic and monetary invariants are restated here so a service bug fails the write
-- rather than corrupting a record somebody later has to explain to a parent.
-- -------------------------------------------------------------------------------------

alter table public.vehicles
  add constraint vehicles_capacity_positive check (capacity > 0);

alter table public.transport_routes
  add constraint transport_routes_status_known check (status in ('active', 'inactive')),
  add constraint transport_routes_distance_non_negative
    check (distance_km is null or distance_km >= 0);

alter table public.route_stops
  add constraint route_stops_sequence_positive check (sequence >= 1),
  -- Coordinates are numeric, never a float, and must be on the planet.
  add constraint route_stops_latitude_range
    check (latitude is null or (latitude >= -90 and latitude <= 90)),
  add constraint route_stops_longitude_range
    check (longitude is null or (longitude >= -180 and longitude <= 180)),
  -- Half a coordinate pins nothing on a map; both or neither.
  add constraint route_stops_coordinates_paired
    check ((latitude is null) = (longitude is null)),
  add constraint route_stops_fare_non_negative check (fare >= 0);

alter table public.route_vehicles
  add constraint route_vehicles_dates_ordered
    check (effective_to is null or effective_to >= effective_from),
  -- An ended assignment records when it ended; an open one has no end.
  add constraint route_vehicles_ended_has_end
    check (status = 'active' or effective_to is not null);

alter table public.student_transport
  add constraint student_transport_dates_ordered
    check (effective_to is null or effective_to >= effective_from),
  add constraint student_transport_ended_has_end
    check (status = 'active' or effective_to is not null),
  add constraint student_transport_fee_override_non_negative
    check (fee_override is null or fee_override >= 0);

alter table public.vehicle_trips
  add constraint vehicle_trips_ended_after_started
    check (ended_at is null or ended_at >= started_at),
  add constraint vehicle_trips_odometer_sane
    check (odometer_start >= 0 and (odometer_end is null or odometer_end >= odometer_start)),
  -- A trip that has ended always carries its closing odometer reading.
  add constraint vehicle_trips_end_recorded
    check (ended_at is null or odometer_end is not null);

alter table public.vehicle_maintenance
  add constraint vehicle_maintenance_cost_non_negative check (cost >= 0),
  add constraint vehicle_maintenance_odometer_non_negative
    check (odometer is null or odometer >= 0);

-- -------------------------------------------------------------------------------------
-- Row-level security.
--
-- The scan in 0002 only covered the tables that existed then. These nine are enabled,
-- forced and given the identical `tenant_isolation` policy here. Both `using` and
-- `with check` are present: `using` gates which rows are visible, `with check` is what stops
-- a session from writing a row stamped with another tenant's id.
-- -------------------------------------------------------------------------------------

do $$
declare
  target text;
  transport_tables constant text[] := array[
    'vehicles',
    'drivers',
    'transport_routes',
    'route_stops',
    'route_vehicles',
    'student_transport',
    'vehicle_trips',
    'trip_attendance',
    'vehicle_maintenance'
  ];
begin
  foreach target in array transport_tables
  loop
    execute format('alter table public.%I enable row level security', target);
    execute format('alter table public.%I force row level security', target);

    execute format('drop policy if exists tenant_isolation on public.%I', target);

    execute format($p$
      create policy tenant_isolation on public.%I
        for all
        using (
          app_is_platform_admin()
          or (tenant_id is not null and tenant_id = app_current_tenant_id())
        )
        with check (
          app_is_platform_admin()
          or (tenant_id is not null and tenant_id = app_current_tenant_id())
        )
    $p$, target);

    -- Default privileges cover tables created by the migrator, but restating the grant makes
    -- this migration correct even if the default privileges were altered between releases.
    execute format('grant select, insert, update, delete on public.%I to shikkha_app', target);
    execute format('grant select on public.%I to shikkha_readonly', target);

    -- `updated_at` is maintained by the trigger, not by the application, so a hand-written
    -- SQL fix in production still leaves an honest timestamp behind.
    execute format('drop trigger if exists set_updated_at on public.%I', target);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function set_updated_at()',
      target
    );
  end loop;
end
$$;

-- -------------------------------------------------------------------------------------
-- Assertions — fail the migration rather than ship a silently-disabled control.
-- -------------------------------------------------------------------------------------

do $$
declare
  offending text;
begin
  -- Named explicitly rather than relying only on the global sweep below, so that a typo in
  -- the array above is a failed migration instead of a table nobody notices is unprotected.
  select string_agg(c.relname, ', ' order by c.relname)
  into offending
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname = any (array[
      'vehicles', 'drivers', 'transport_routes', 'route_stops', 'route_vehicles',
      'student_transport', 'vehicle_trips', 'trip_attendance', 'vehicle_maintenance'
    ])
    and (
      not c.relrowsecurity
      or not c.relforcerowsecurity
      or not exists (
        select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation'
      )
    );

  if offending is not null then
    raise exception
      'Transport tables without forced row-level security and a tenant_isolation policy: %',
      offending;
  end if;

  -- Every one of the nine must also carry the tenant column the policy reads. A policy on a
  -- table without `tenant_id` would fail at query time, not here.
  select string_agg(t.name, ', ' order by t.name)
  into offending
  from unnest(array[
    'vehicles', 'drivers', 'transport_routes', 'route_stops', 'route_vehicles',
    'student_transport', 'vehicle_trips', 'trip_attendance', 'vehicle_maintenance'
  ]) as t(name)
  where not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = t.name
      and a.attname = 'tenant_id'
      and a.attnum > 0
      and not a.attisdropped
  );

  if offending is not null then
    raise exception 'Transport tables without a tenant_id column: %', offending;
  end if;
end
$$;

-- The global sweep: every public table is either RLS-protected or explicitly exempt.
select assert_rls_coverage();
