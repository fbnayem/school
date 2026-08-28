/**
 * Integration test harness.
 *
 * Boots the real application — real guards, real interceptors, real database — against a
 * dedicated `shikkha_test` database. Nothing is stubbed, because the properties these tests
 * assert (tenant isolation, permission enforcement, RLS) live precisely in the parts a stub
 * would replace.
 *
 * The test database is migrated once per run and its tenant data is rebuilt per suite, so a
 * suite that leaves rows behind cannot make the next one pass or fail spuriously.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import argon2 from 'argon2';
import { uuidv7 } from '@shikkha/shared';
import { SYSTEM_ROLES } from '@shikkha/permissions';
import { migrate } from '@shikkha/db';
import { resolve } from 'node:path';
import { AppModule } from '../../src/app.module';
import { resetEnvCache } from '../../src/config/env';

const TEST_DB = 'shikkha_test';
const HOST = process.env.TEST_DB_HOST ?? 'localhost';
const PORT = process.env.TEST_DB_PORT ?? '5433';
const PASSWORD = process.env.TEST_DB_PASSWORD ?? 'shikkha_dev_password';

export const TEST_APP_DATABASE_URL = `postgres://shikkha_app:${PASSWORD}@${HOST}:${PORT}/${TEST_DB}`;
export const TEST_MIGRATION_DATABASE_URL = `postgres://shikkha_migrator:${PASSWORD}@${HOST}:${PORT}/${TEST_DB}`;

/** The password every seeded test user shares. */
export const TEST_PASSWORD = 'TestPassword2026!';

let migrated = false;

/**
 * Apply migrations to the test database once per process.
 *
 * Idempotent by design — the migrator records what it has applied — so calling it from every
 * suite's `beforeAll` costs one query after the first.
 */
export async function ensureTestDatabase(): Promise<void> {
  if (migrated) return;
  await migrate({
    connectionString: TEST_MIGRATION_DATABASE_URL,
    migrationsDir: resolve(__dirname, '../../../../packages/db/migrations'),
    log: () => undefined,
  });
  migrated = true;
}

export function configureTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = TEST_APP_DATABASE_URL;
  process.env.MIGRATION_DATABASE_URL = TEST_MIGRATION_DATABASE_URL;
  process.env.JWT_SECRET = 'integration-test-signing-key-at-least-32-characters-long';
  process.env.LOG_LEVEL = 'silent';
  process.env.LOG_PRETTY = 'false';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_PATH = './storage-test';
  // Effectively disabled: these suites deliberately hammer the login endpoint to prove the
  // lockout works, and a request-rate limit would mask the account-level behaviour under test.
  process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
  process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = '100000';
  // The real cost parameters make ~50 password hashes take several seconds. The suites here
  // test authentication *logic*, not the KDF; the KDF's parameters are asserted separately.
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_TIME_COST = '2';
  resetEnvCache();
}

export async function createTestApp(): Promise<INestApplication> {
  configureTestEnv();
  await ensureTestDatabase();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  await app.init();
  return app;
}

export function testClient(): Client {
  return new Client({ connectionString: TEST_MIGRATION_DATABASE_URL });
}

/**
 * Remove every tenant's data.
 *
 * Runs as the migrator (which owns the tables and bypasses RLS) so it can see and delete rows
 * across all tenants — which is exactly what a per-suite reset needs to do, and exactly what
 * the application role must never be able to do.
 */
export async function truncateAll(): Promise<void> {
  const client = testClient();
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' and tablename <> '_migrations'`,
    );
    if (rows.length === 0) return;
    const list = rows.map((row) => `public."${row.tablename}"`).join(', ');
    // CASCADE handles the foreign-key graph; RESTART IDENTITY resets sequences so tests that
    // assert on generated codes see the same values every run.
    await client.query(`truncate ${list} restart identity cascade`);
  } finally {
    await client.end();
  }
}

export interface SeededTenant {
  tenantId: string;
  institutionId: string;
  campusId: string;
  academicYearId: string;
  classLevelId: string;
  sectionId: string;
  roleIds: Record<string, string>;
  users: Record<string, { id: string; email: string }>;
  studentIds: string[];
  guardianIds: string[];
  employeeIds: string[];
}

/**
 * Build a complete, self-contained tenant.
 *
 * Called twice by the isolation suite to create two tenants that are structurally identical
 * and must never see each other. Everything is parameterised by `prefix` so the two do not
 * collide on any unique constraint — if they did, the test would fail for the wrong reason.
 */
export async function seedTenant(
  prefix: string,
  options: { students?: number } = {},
): Promise<SeededTenant> {
  const studentCount = options.students ?? 5;
  const client = testClient();
  await client.connect();

  try {
    await client.query('begin');

    const tenantId = uuidv7();
    await client.query(
      `insert into organizations (id, slug, name_en, contact_email)
       values ($1, $2, $3, $4)`,
      [tenantId, `${prefix}-org`, `${prefix} School`, `${prefix}@example.test`],
    );

    const institutionId = uuidv7();
    await client.query(
      `insert into institutions (id, tenant_id, code, name_en, type, medium)
       values ($1,$2,$3,$4,'school','bangla')`,
      [institutionId, tenantId, `${prefix}-INST`, `${prefix} Main Institution`],
    );

    const campusId = uuidv7();
    await client.query(
      `insert into campuses (id, tenant_id, institution_id, code, name_en, is_primary)
       values ($1,$2,$3,'MAIN',$4,true)`,
      [campusId, tenantId, institutionId, `${prefix} Main Campus`],
    );

    const academicYearId = uuidv7();
    await client.query(
      `insert into academic_years (id, tenant_id, institution_id, name, start_date, end_date, status, is_current)
       values ($1,$2,$3,'2026','2026-01-01','2026-12-31','active',true)`,
      [academicYearId, tenantId, institutionId],
    );

    const classLevelId = uuidv7();
    await client.query(
      `insert into class_levels (id, tenant_id, institution_id, code, name_en, ordinal)
       values ($1,$2,$3,'C6','Class 6',7)`,
      [classLevelId, tenantId, institutionId],
    );

    const sectionId = uuidv7();
    await client.query(
      `insert into sections (id, tenant_id, institution_id, campus_id, academic_year_id, class_level_id, name_en, capacity)
       values ($1,$2,$3,$4,$5,$6,'A',60)`,
      [sectionId, tenantId, institutionId, campusId, academicYearId, classLevelId],
    );

    // Every system role, so a test can assume any role exists without seeding it first.
    const roleIds: Record<string, string> = {};
    for (const role of SYSTEM_ROLES) {
      const id = uuidv7();
      roleIds[role.key] = id;
      await client.query(
        `insert into roles (id, tenant_id, key, name_en, permissions, audience, is_system, is_sensitive)
         values ($1,$2,$3,$4,$5::jsonb,$6,true,$7)`,
        [
          id,
          tenantId,
          role.key,
          role.nameEn,
          JSON.stringify(role.permissions),
          role.audience,
          role.sensitive,
        ],
      );
    }

    const passwordHash = await argon2.hash(TEST_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
    });

    const users: Record<string, { id: string; email: string }> = {};
    const employeeIds: string[] = [];

    async function createUser(
      key: string,
      roleKey: string,
      opts: { asEmployee?: boolean } = {},
    ): Promise<string> {
      const userId = uuidv7();
      const email = `${key}@${prefix}.test`;
      await client.query(
        `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
         values ($1,$2,$3,$4,$5,'active',now())`,
        [userId, tenantId, email, passwordHash, `${prefix} ${key}`],
      );
      await client.query(
        `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
         values ($1,$2,$3,$4,$5)`,
        [uuidv7(), tenantId, userId, roleIds[roleKey], institutionId],
      );
      if (opts.asEmployee) {
        const employeeId = uuidv7();
        employeeIds.push(employeeId);
        await client.query(
          `insert into employees (id, tenant_id, institution_id, campus_id, user_id, employee_code, full_name_en, phone, joining_date)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'2020-01-01')`,
          [
            employeeId,
            tenantId,
            institutionId,
            campusId,
            userId,
            `${prefix}-EMP-${employeeIds.length + 1}`,
            `${prefix} ${key}`,
            `+880171${String(employeeIds.length).padStart(7, '0')}`,
          ],
        );
      }
      users[key] = { id: userId, email };
      return userId;
    }

    await createUser('owner', 'school_owner', { asEmployee: true });
    await createUser('principal', 'principal', { asEmployee: true });
    await createUser('admin', 'administrator', { asEmployee: true });
    await createUser('accountant', 'accountant', { asEmployee: true });
    await createUser('teacher', 'teacher', { asEmployee: true });

    // The teacher is the class teacher of the seeded section, so the "assigned" data scope
    // resolves to a non-empty set rather than trivially to nothing.
    const teacherEmployeeId = employeeIds[4]!;
    await client.query(
      `insert into employee_section_assignments (id, tenant_id, institution_id, academic_year_id, employee_id, section_id, role)
       values ($1,$2,$3,$4,$5,$6,'class_teacher')`,
      [uuidv7(), tenantId, institutionId, academicYearId, teacherEmployeeId, sectionId],
    );

    // Students, guardians and the links between them.
    const studentIds: string[] = [];
    const guardianIds: string[] = [];

    for (let i = 0; i < studentCount; i += 1) {
      const studentId = uuidv7();
      studentIds.push(studentId);
      await client.query(
        `insert into students (id, tenant_id, institution_id, student_code, admission_number, admission_date, full_name_en, date_of_birth, gender, status)
         values ($1,$2,$3,$4,$5,'2026-01-05',$6,'2014-05-10','male','active')`,
        [
          studentId,
          tenantId,
          institutionId,
          `${prefix}-S${i + 1}`,
          `${prefix}-A${i + 1}`,
          `${prefix} Student ${i + 1}`,
        ],
      );
      await client.query(
        `insert into enrollments (id, tenant_id, institution_id, campus_id, student_id, academic_year_id, class_level_id, section_id, roll_number, status, enrolled_on)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','2026-01-05')`,
        [
          uuidv7(),
          tenantId,
          institutionId,
          campusId,
          studentId,
          academicYearId,
          classLevelId,
          sectionId,
          String(i + 1),
        ],
      );

      const guardianId = uuidv7();
      guardianIds.push(guardianId);
      const guardianUserId = uuidv7();
      const guardianEmail = `guardian${i + 1}@${prefix}.test`;
      await client.query(
        `insert into users (id, tenant_id, email, password_hash, full_name_en, status, email_verified_at)
         values ($1,$2,$3,$4,$5,'active',now())`,
        [guardianUserId, tenantId, guardianEmail, passwordHash, `${prefix} Guardian ${i + 1}`],
      );
      await client.query(
        `insert into user_roles (id, tenant_id, user_id, role_id, institution_id)
         values ($1,$2,$3,$4,$5)`,
        [uuidv7(), tenantId, guardianUserId, roleIds['guardian'], institutionId],
      );
      await client.query(
        `insert into guardians (id, tenant_id, institution_id, user_id, full_name_en, phone)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          guardianId,
          tenantId,
          institutionId,
          guardianUserId,
          `${prefix} Guardian ${i + 1}`,
          `+8801${prefix.length}${String(i).padStart(8, '0')}`.slice(0, 14),
        ],
      );
      await client.query(
        `insert into student_guardians (id, tenant_id, institution_id, student_id, guardian_id, relation, is_primary, is_billing_contact, can_access_portal)
         values ($1,$2,$3,$4,$5,'father',true,true,true)`,
        [uuidv7(), tenantId, institutionId, studentId, guardianId],
      );
      users[`guardian${i + 1}`] = { id: guardianUserId, email: guardianEmail };
    }

    await client.query('commit');

    return {
      tenantId,
      institutionId,
      campusId,
      academicYearId,
      classLevelId,
      sectionId,
      roleIds,
      users,
      studentIds,
      guardianIds,
      employeeIds,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
