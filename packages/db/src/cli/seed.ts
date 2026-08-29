#!/usr/bin/env tsx
/**
 * Seed a realistic demo tenant.
 *
 *   pnpm db:seed                 small school (~480 students)
 *   pnpm db:seed -- --scale=medium
 *   pnpm db:seed -- --scale=large
 *   pnpm db:seed -- --fresh      wipe the demo tenant first
 *
 * Runs as the migrator role, which owns the tables and therefore bypasses RLS. That is
 * necessary here — the seeder creates the tenant, and there is no tenant context to run
 * inside until it exists — and it is exactly why the API connects as a different role.
 *
 * Inserts are batched: a 10,000-student seed issued one row at a time would take minutes of
 * round trips against a local database and considerably longer against a remote one.
 */

import { Client } from 'pg';
import argon2 from 'argon2';
import { SYSTEM_ROLES, DEFAULT_SEEDED_ROLE_KEYS } from '@shikkha/permissions';
import { uuidv7 } from '@shikkha/shared';
import {
  ACADEMIC_GROUPS,
  CLASS_LEVELS,
  DEPARTMENTS,
  DESIGNATIONS,
  SEED_SCALES,
  SUBJECTS,
  SeededRandom,
  generateAddress,
  generateBirthRegistration,
  generateDateOfBirth,
  generateOccupation,
  generatePerson,
  generatePhone,
} from '../seed/demo-data';
import { loadRepoEnv } from './load-env';

/**
 * The theory/practical split for a subject's marks.
 *
 * The practical share is rounded and theory takes whatever is left, rather than both being
 * rounded independently. Rounding both gave 38 + 13 = 51 for a 50-mark subject, which
 * `class_subjects_mark_distribution_sums` (migration 0015) rejects — so `pnpm db:seed --fresh`
 * failed outright on a clean database, on the very command the README documents first.
 * Deriving one component from the other makes the sum exact for every value of `fullMarks`,
 * not only the ones that happen to divide evenly.
 */
export function markDistribution(
  fullMarks: number,
  hasPractical: boolean,
): Record<string, number> {
  if (!hasPractical) return { theory: fullMarks };
  const practical = Math.round(fullMarks * 0.25);
  return { theory: fullMarks - practical, practical };
}

loadRepoEnv();

const DEMO_TENANT_SLUG = 'dhaka-future-academy';
const DEMO_PASSWORD = 'ShikkhaDemo2026!';
const ACADEMIC_YEAR = 2026;

interface Args {
  scale: keyof typeof SEED_SCALES;
  fresh: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const scaleArg = argv.find((a) => a.startsWith('--scale='))?.split('=')[1] ?? 'small';
  if (!(scaleArg in SEED_SCALES)) {
    console.error(
      `Unknown scale "${scaleArg}". Choose one of: ${Object.keys(SEED_SCALES).join(', ')}`,
    );
    process.exit(1);
  }
  return { scale: scaleArg as keyof typeof SEED_SCALES, fresh: argv.includes('--fresh') };
}

/** Batched multi-row INSERT. Chunked so a parameter count stays under Postgres's 65535 limit. */
async function insertMany(
  client: Client,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const maxRowsPerStatement = Math.max(1, Math.floor(60_000 / columns.length));

  for (let offset = 0; offset < rows.length; offset += maxRowsPerStatement) {
    const chunk = rows.slice(offset, offset + maxRowsPerStatement);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(',')})`;
    });
    await client.query(
      `insert into ${table} (${columns.map((c) => `"${c}"`).join(',')}) values ${tuples.join(',')}`,
      params,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const scale = SEED_SCALES[args.scale]!;
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('Set MIGRATION_DATABASE_URL (owner role) to seed.');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo data into a production database.');
    process.exit(1);
  }

  const rng = new SeededRandom();
  const usedPhones = new Set<string>();
  const client = new Client({ connectionString: url });
  await client.connect();
  const startedAt = Date.now();

  try {
    console.log(`Seeding: ${scale.label}`);

    if (args.fresh) {
      // Ordered by dependency. `on delete restrict` on the tenancy tables means the children
      // must go first, and doing it in one transaction keeps the database consistent if the
      // seed then fails.
      console.log('  removing existing demo tenant');
      await client.query('begin');
      const existing = await client.query<{ id: string }>(
        'select id from organizations where slug = $1',
        [DEMO_TENANT_SLUG],
      );
      const tenantId = existing.rows[0]?.id;
      if (tenantId) {
        for (const table of [
          'student_status_history',
          'student_documents',
          'student_guardians',
          'enrollments',
          'guardians',
          'students',
          'employee_subject_assignments',
          'employee_section_assignments',
          'employees',
          'departments',
          'designations',
          'class_subjects',
          'sections',
          'academic_groups',
          'class_levels',
          'subjects',
          'periods',
          'shifts',
          'calendar_events',
          'terms',
          'academic_years',
          'rooms',
          'files',
          'sessions',
          'auth_tokens',
          'user_roles',
          'roles',
          'users',
          'feature_flag_overrides',
          'subscriptions',
          'campuses',
          'institutions',
        ]) {
          await client.query(`delete from ${table} where tenant_id = $1`, [tenantId]);
        }
        // audit_logs is append-only for the app role but the migrator may prune demo data.
        await client.query('delete from audit_logs where tenant_id = $1', [tenantId]);
        await client.query('delete from security_events where tenant_id = $1', [tenantId]);
        await client.query('delete from organizations where id = $1', [tenantId]);
      }
      await client.query('commit');
    }

    await client.query('begin');

    // ── Organization and institutions ─────────────────────────────────────────────────
    const tenantId = uuidv7();
    await client.query(
      `insert into organizations (id, slug, name_en, name_bn, contact_email, contact_phone, timezone, default_locale, currency)
       values ($1,$2,$3,$4,$5,$6,'Asia/Dhaka','bn','BDT')`,
      [
        tenantId,
        DEMO_TENANT_SLUG,
        'Dhaka Future Academy',
        'ঢাকা ফিউচার একাডেমি',
        'office@dhakafuture.test',
        '+8801711000000',
      ],
    );

    const institutionId = uuidv7();
    await client.query(
      `insert into institutions (id, tenant_id, code, name_en, name_bn, type, medium, eiin, education_board, established_year, address_line1, district, division, phone, email)
       values ($1,$2,'DFA','Dhaka Future Academy','ঢাকা ফিউচার একাডেমি','school','bangla','108234','Dhaka',1998,$3,'Dhaka','Dhaka','+8801711000000','office@dhakafuture.test')`,
      [institutionId, tenantId, 'Plot 14, Road 7, Mirpur, Dhaka-1216'],
    );

    const campusId = uuidv7();
    await client.query(
      `insert into campuses (id, tenant_id, institution_id, code, name_en, name_bn, is_primary, address_line1, district, division)
       values ($1,$2,$3,'MAIN','Main Campus','প্রধান ক্যাম্পাস',true,$4,'Dhaka','Dhaka')`,
      [campusId, tenantId, institutionId, 'Plot 14, Road 7, Mirpur, Dhaka-1216'],
    );

    // ── Roles ─────────────────────────────────────────────────────────────────────────
    const roleIdByKey = new Map<string, string>();
    await insertMany(
      client,
      'roles',
      [
        'id',
        'tenant_id',
        'key',
        'name_en',
        'name_bn',
        'description',
        'permissions',
        'audience',
        'is_system',
        'is_sensitive',
      ],
      SYSTEM_ROLES.filter((role) => DEFAULT_SEEDED_ROLE_KEYS.includes(role.key)).map((role) => {
        const id = uuidv7();
        roleIdByKey.set(role.key, id);
        return [
          id,
          tenantId,
          role.key,
          role.nameEn,
          role.nameBn,
          role.description,
          JSON.stringify(role.permissions),
          role.audience,
          true,
          role.sensitive,
        ];
      }),
    );

    // ── Academic year and terms ───────────────────────────────────────────────────────
    const academicYearId = uuidv7();
    await client.query(
      `insert into academic_years (id, tenant_id, institution_id, name, start_date, end_date, status, is_current, weekend_days)
       values ($1,$2,$3,$4,$5,$6,'active',true,'[5,6]'::jsonb)`,
      [
        academicYearId,
        tenantId,
        institutionId,
        String(ACADEMIC_YEAR),
        `${ACADEMIC_YEAR}-01-01`,
        `${ACADEMIC_YEAR}-12-31`,
      ],
    );

    // Three terms with weights summing to exactly 10000 basis points.
    await insertMany(
      client,
      'terms',
      [
        'id',
        'tenant_id',
        'institution_id',
        'academic_year_id',
        'name_en',
        'name_bn',
        'sequence',
        'start_date',
        'end_date',
        'weight_basis_points',
      ],
      [
        [
          uuidv7(),
          tenantId,
          institutionId,
          academicYearId,
          'First Term',
          'প্রথম সাময়িক',
          1,
          `${ACADEMIC_YEAR}-01-01`,
          `${ACADEMIC_YEAR}-04-30`,
          3000,
        ],
        [
          uuidv7(),
          tenantId,
          institutionId,
          academicYearId,
          'Second Term',
          'দ্বিতীয় সাময়িক',
          2,
          `${ACADEMIC_YEAR}-05-01`,
          `${ACADEMIC_YEAR}-08-31`,
          3000,
        ],
        [
          uuidv7(),
          tenantId,
          institutionId,
          academicYearId,
          'Annual Examination',
          'বার্ষিক পরীক্ষা',
          3,
          `${ACADEMIC_YEAR}-09-01`,
          `${ACADEMIC_YEAR}-12-31`,
          4000,
        ],
      ],
    );

    // ── Shifts ────────────────────────────────────────────────────────────────────────
    const morningShiftId = uuidv7();
    const dayShiftId = uuidv7();
    await insertMany(
      client,
      'shifts',
      [
        'id',
        'tenant_id',
        'institution_id',
        'campus_id',
        'kind',
        'name_en',
        'name_bn',
        'start_time',
        'end_time',
        'sort_order',
      ],
      [
        [
          morningShiftId,
          tenantId,
          institutionId,
          campusId,
          'morning',
          'Morning Shift',
          'প্রভাতী শাখা',
          '07:30',
          '12:00',
          1,
        ],
        [
          dayShiftId,
          tenantId,
          institutionId,
          campusId,
          'day',
          'Day Shift',
          'দিবা শাখা',
          '12:30',
          '17:00',
          2,
        ],
      ],
    );

    // ── Class levels, groups, subjects ────────────────────────────────────────────────
    const classLevelIds = new Map<string, string>();
    await insertMany(
      client,
      'class_levels',
      ['id', 'tenant_id', 'institution_id', 'code', 'name_en', 'name_bn', 'ordinal', 'has_groups'],
      CLASS_LEVELS.map((level) => {
        const id = uuidv7();
        classLevelIds.set(level.code, id);
        return [
          id,
          tenantId,
          institutionId,
          level.code,
          level.nameEn,
          level.nameBn,
          level.ordinal,
          level.hasGroups,
        ];
      }),
    );

    const groupIds = new Map<string, string>();
    await insertMany(
      client,
      'academic_groups',
      ['id', 'tenant_id', 'institution_id', 'code', 'name_en', 'name_bn', 'sort_order'],
      ACADEMIC_GROUPS.map((group, index) => {
        const id = uuidv7();
        groupIds.set(group.code, id);
        return [id, tenantId, institutionId, group.code, group.nameEn, group.nameBn, index];
      }),
    );

    const subjectIds = new Map<string, string>();
    await insertMany(
      client,
      'subjects',
      [
        'id',
        'tenant_id',
        'institution_id',
        'code',
        'name_en',
        'name_bn',
        'short_name',
        'kind',
        'is_fourth_subject',
        'exclude_from_gpa',
        'has_practical',
        'sort_order',
      ],
      SUBJECTS.map((subject, index) => {
        const id = uuidv7();
        subjectIds.set(subject.code, id);
        return [
          id,
          tenantId,
          institutionId,
          subject.code,
          subject.nameEn,
          subject.nameBn,
          subject.shortName,
          subject.kind,
          subject.isFourthSubject,
          subject.excludeFromGpa,
          subject.hasPractical,
          index,
        ];
      }),
    );

    // Curriculum: which subjects each class studies. Secondary classes (ordinal >= 7) take the
    // full set; primary classes take the core only.
    const classSubjectRows: unknown[][] = [];
    for (const level of CLASS_LEVELS) {
      const isSecondary = level.ordinal >= 7;
      for (const subject of SUBJECTS) {
        if (!isSecondary && subject.kind === 'optional') continue;
        if (!isSecondary && subject.code === '154') continue; // ICT starts at secondary.
        classSubjectRows.push([
          uuidv7(),
          tenantId,
          institutionId,
          academicYearId,
          classLevelIds.get(level.code),
          subjectIds.get(subject.code),
          null,
          subject.periodsPerWeek,
          subject.fullMarks,
          subject.passMarks,
          JSON.stringify(markDistribution(subject.fullMarks, subject.hasPractical)),
          subject.kind === 'optional',
        ]);
      }
    }
    await insertMany(
      client,
      'class_subjects',
      [
        'id',
        'tenant_id',
        'institution_id',
        'academic_year_id',
        'class_level_id',
        'subject_id',
        'group_id',
        'periods_per_week',
        'full_marks',
        'pass_marks',
        'mark_distribution',
        'is_optional',
      ],
      classSubjectRows,
    );

    // ── Departments and designations ──────────────────────────────────────────────────
    const departmentIds = new Map<string, string>();
    await insertMany(
      client,
      'departments',
      ['id', 'tenant_id', 'institution_id', 'code', 'name_en', 'name_bn'],
      DEPARTMENTS.map((dept) => {
        const id = uuidv7();
        departmentIds.set(dept.code, id);
        return [id, tenantId, institutionId, dept.code, dept.nameEn, dept.nameBn];
      }),
    );

    const designationIds = new Map<string, string>();
    await insertMany(
      client,
      'designations',
      ['id', 'tenant_id', 'institution_id', 'code', 'name_en', 'name_bn', 'rank', 'is_teaching'],
      DESIGNATIONS.map((designation) => {
        const id = uuidv7();
        designationIds.set(designation.code, id);
        return [
          id,
          tenantId,
          institutionId,
          designation.code,
          designation.nameEn,
          designation.nameBn,
          designation.rank,
          designation.isTeaching,
        ];
      }),
    );

    // ── Sections ──────────────────────────────────────────────────────────────────────
    const SECTION_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    interface SeededSection {
      id: string;
      classCode: string;
      classOrdinal: number;
      name: string;
      shiftId: string;
      groupId: string | null;
    }
    const seededSections: SeededSection[] = [];
    const sectionRows: unknown[][] = [];

    for (const level of CLASS_LEVELS) {
      for (const shiftId of [morningShiftId, dayShiftId]) {
        for (let index = 0; index < scale.sectionsPerClass; index += 1) {
          const groupCode = level.hasGroups
            ? ACADEMIC_GROUPS[index % ACADEMIC_GROUPS.length]!.code
            : null;
          const section: SeededSection = {
            id: uuidv7(),
            classCode: level.code,
            classOrdinal: level.ordinal,
            name: SECTION_NAMES[index]!,
            shiftId,
            groupId: groupCode ? groupIds.get(groupCode)! : null,
          };
          seededSections.push(section);
          sectionRows.push([
            section.id,
            tenantId,
            institutionId,
            campusId,
            academicYearId,
            classLevelIds.get(level.code),
            shiftId,
            section.groupId,
            section.name,
            null,
            scale.studentsPerSection + 10,
          ]);
        }
      }
    }
    await insertMany(
      client,
      'sections',
      [
        'id',
        'tenant_id',
        'institution_id',
        'campus_id',
        'academic_year_id',
        'class_level_id',
        'shift_id',
        'group_id',
        'name_en',
        'name_bn',
        'capacity',
      ],
      sectionRows,
    );

    // ── Users and employees ───────────────────────────────────────────────────────────
    // One hash reused for every demo account. Argon2 at production parameters takes ~50ms, so
    // hashing 200 staff accounts individually would add ten seconds to every seed for no value.
    const passwordHash = await argon2.hash(DEMO_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    interface StaffSpec {
      email: string;
      roleKey: string;
      designation: string;
      department: string;
      person: { fullNameEn: string; fullNameBn: string; gender: 'male' | 'female' };
    }

    const staffSpecs: StaffSpec[] = [
      {
        email: 'owner@dhakafuture.test',
        roleKey: 'school_owner',
        designation: 'PRIN',
        department: 'ADMIN',
        person: generatePerson(rng, 'male'),
      },
      {
        email: 'principal@dhakafuture.test',
        roleKey: 'principal',
        designation: 'PRIN',
        department: 'ADMIN',
        person: generatePerson(rng, 'female'),
      },
      {
        email: 'admin@dhakafuture.test',
        roleKey: 'administrator',
        designation: 'OFFASST',
        department: 'ADMIN',
        person: generatePerson(rng),
      },
      {
        email: 'accountant@dhakafuture.test',
        roleKey: 'accountant',
        designation: 'ACCT',
        department: 'ADMIN',
        person: generatePerson(rng),
      },
      {
        email: 'controller@dhakafuture.test',
        roleKey: 'examination_controller',
        designation: 'ASTHEAD',
        department: 'ADMIN',
        person: generatePerson(rng, 'male'),
      },
    ];

    // One teacher per section, so every section has a class teacher and the "assigned" data
    // scope has something to resolve against.
    const teacherCount = seededSections.length;
    for (let i = 0; i < teacherCount; i += 1) {
      staffSpecs.push({
        email: `teacher${i + 1}@dhakafuture.test`,
        roleKey: i % 2 === 0 ? 'class_teacher' : 'teacher',
        designation: rng.pick(['TCH', 'SRTCH']),
        department: rng.pick(['SCI', 'ARTS', 'LANG', 'MATH']),
        person: generatePerson(rng),
      });
    }

    const userRows: unknown[][] = [];
    const employeeRows: unknown[][] = [];
    const userRoleRows: unknown[][] = [];
    const employeeIds: string[] = [];

    staffSpecs.forEach((spec, index) => {
      const userId = uuidv7();
      const employeeId = uuidv7();
      employeeIds.push(employeeId);

      userRows.push([
        userId,
        tenantId,
        spec.email,
        generatePhone(rng, usedPhones),
        passwordHash,
        spec.person.fullNameEn,
        spec.person.fullNameBn,
        'en',
        'active',
        new Date(),
      ]);

      employeeRows.push([
        employeeId,
        tenantId,
        institutionId,
        campusId,
        userId,
        `EMP${String(index + 1).padStart(4, '0')}`,
        spec.person.fullNameEn,
        spec.person.fullNameBn,
        `${ACADEMIC_YEAR - 40}-0${rng.int(1, 9)}-1${rng.int(0, 9)}`,
        spec.person.gender,
        generatePhone(rng, usedPhones),
        spec.email,
        departmentIds.get(spec.department),
        designationIds.get(spec.designation),
        'permanent',
        'active',
        `${ACADEMIC_YEAR - rng.int(1, 12)}-01-15`,
        generateAddress(rng),
      ]);

      const roleId = roleIdByKey.get(spec.roleKey);
      if (roleId) {
        userRoleRows.push([uuidv7(), tenantId, userId, roleId, institutionId, null]);
      }
    });

    await insertMany(
      client,
      'users',
      [
        'id',
        'tenant_id',
        'email',
        'phone',
        'password_hash',
        'full_name_en',
        'full_name_bn',
        'locale',
        'status',
        'email_verified_at',
      ],
      userRows,
    );
    await insertMany(
      client,
      'employees',
      [
        'id',
        'tenant_id',
        'institution_id',
        'campus_id',
        'user_id',
        'employee_code',
        'full_name_en',
        'full_name_bn',
        'date_of_birth',
        'gender',
        'phone',
        'email',
        'department_id',
        'designation_id',
        'employment_type',
        'employment_status',
        'joining_date',
        'present_address',
      ],
      employeeRows,
    );

    // Class-teacher assignments: teachers start at index 5 (after the five admin staff).
    const sectionAssignmentRows: unknown[][] = [];
    seededSections.forEach((section, index) => {
      const employeeId = employeeIds[5 + index];
      if (!employeeId) return;
      sectionAssignmentRows.push([
        uuidv7(),
        tenantId,
        institutionId,
        academicYearId,
        employeeId,
        section.id,
        'class_teacher',
      ]);
    });
    await insertMany(
      client,
      'employee_section_assignments',
      [
        'id',
        'tenant_id',
        'institution_id',
        'academic_year_id',
        'employee_id',
        'section_id',
        'role',
      ],
      sectionAssignmentRows,
    );

    // ── Students, guardians and enrolments ────────────────────────────────────────────
    const studentRows: unknown[][] = [];
    const enrollmentRows: unknown[][] = [];
    const guardianRows: unknown[][] = [];
    const linkRows: unknown[][] = [];
    const historyRows: unknown[][] = [];

    let studentSequence = 0;
    let guardianSequence = 0;
    // Reused across siblings so the "one guardian, several children" path is exercised.
    // `children` is tracked so one guardian does not accumulate every student who happens to
    // share a surname — the first version did exactly that and produced a parent with nine
    // children, which is not what the parent portal should be demonstrating.
    const siblingGuardians: { id: string; surname: string; children: number }[] = [];

    for (const section of seededSections) {
      for (let roll = 1; roll <= scale.studentsPerSection; roll += 1) {
        studentSequence += 1;
        const person = generatePerson(rng);
        const dateOfBirth = generateDateOfBirth(rng, section.classOrdinal, ACADEMIC_YEAR);
        const birthYear = Number(dateOfBirth.slice(0, 4));
        const studentId = uuidv7();
        const surname = person.fullNameEn.split(' ')[1]!;

        studentRows.push([
          studentId,
          tenantId,
          institutionId,
          `S${ACADEMIC_YEAR}${String(studentSequence).padStart(5, '0')}`,
          `A${ACADEMIC_YEAR}${String(studentSequence).padStart(5, '0')}`,
          `${ACADEMIC_YEAR}-01-05`,
          person.fullNameEn,
          person.fullNameBn,
          dateOfBirth,
          person.gender,
          rng.pick(['A+', 'B+', 'O+', 'AB+', 'A-', 'B-', 'O-']),
          rng.chance(0.9) ? 'islam' : rng.pick(['hinduism', 'christianity', 'buddhism']),
          generateBirthRegistration(rng, birthYear),
          generateAddress(rng),
          'Dhaka',
          'Dhaka',
          'active',
        ]);

        enrollmentRows.push([
          uuidv7(),
          tenantId,
          institutionId,
          campusId,
          studentId,
          academicYearId,
          classLevelIds.get(section.classCode),
          section.id,
          section.shiftId,
          section.groupId,
          String(roll),
          'active',
          `${ACADEMIC_YEAR}-01-05`,
        ]);

        historyRows.push([
          uuidv7(),
          tenantId,
          institutionId,
          studentId,
          'admitted',
          null,
          'active',
          `${ACADEMIC_YEAR}-01-05`,
        ]);

        // ~12% of students share a guardian with an earlier sibling of the same surname,
        // capped at three children per guardian.
        const sibling = rng.chance(0.12)
          ? siblingGuardians.find(
              (candidate) => candidate.surname === surname && candidate.children < 3,
            )
          : undefined;

        if (sibling) {
          sibling.children += 1;
          linkRows.push([
            uuidv7(),
            tenantId,
            institutionId,
            studentId,
            sibling.id,
            'father',
            true,
            true,
            true,
            true,
            true,
          ]);
        } else {
          guardianSequence += 1;
          const guardianId = uuidv7();
          const guardianPerson = generatePerson(rng, 'male');
          guardianRows.push([
            guardianId,
            tenantId,
            institutionId,
            `${guardianPerson.fullNameEn.split(' ')[0]} ${surname}`,
            `${guardianPerson.fullNameBn.split(' ')[0]} ${surname}`,
            generatePhone(rng, usedPhones),
            guardianSequence <= 3 ? `parent${guardianSequence}@dhakafuture.test` : null,
            generateOccupation(rng),
            rng.pick(['under_15k', '15k_30k', '30k_60k', '60k_100k']),
            generateAddress(rng),
            'sms',
            'bn',
          ]);
          siblingGuardians.push({ id: guardianId, surname, children: 1 });

          linkRows.push([
            uuidv7(),
            tenantId,
            institutionId,
            studentId,
            guardianId,
            'father',
            true,
            true,
            true,
            true,
            true,
          ]);
        }
      }
    }

    await insertMany(
      client,
      'students',
      [
        'id',
        'tenant_id',
        'institution_id',
        'student_code',
        'admission_number',
        'admission_date',
        'full_name_en',
        'full_name_bn',
        'date_of_birth',
        'gender',
        'blood_group',
        'religion',
        'birth_registration_number',
        'present_address',
        'district',
        'division',
        'status',
      ],
      studentRows,
    );
    await insertMany(
      client,
      'guardians',
      [
        'id',
        'tenant_id',
        'institution_id',
        'full_name_en',
        'full_name_bn',
        'phone',
        'email',
        'occupation',
        'income_band',
        'address',
        'preferred_channel',
        'preferred_locale',
      ],
      guardianRows,
    );
    await insertMany(
      client,
      'enrollments',
      [
        'id',
        'tenant_id',
        'institution_id',
        'campus_id',
        'student_id',
        'academic_year_id',
        'class_level_id',
        'section_id',
        'shift_id',
        'group_id',
        'roll_number',
        'status',
        'enrolled_on',
      ],
      enrollmentRows,
    );
    await insertMany(
      client,
      'student_guardians',
      [
        'id',
        'tenant_id',
        'institution_id',
        'student_id',
        'guardian_id',
        'relation',
        'is_primary',
        'is_billing_contact',
        'is_emergency_contact',
        'can_access_portal',
        'has_custody',
      ],
      linkRows,
    );
    await insertMany(
      client,
      'student_status_history',
      [
        'id',
        'tenant_id',
        'institution_id',
        'student_id',
        'event',
        'from_status',
        'to_status',
        'effective_date',
      ],
      historyRows,
    );

    // Give the first three guardians portal logins so the parent flows are testable.
    const portalGuardians = guardianRows.slice(0, 3);
    const guardianRoleId = roleIdByKey.get('guardian');
    for (const guardian of portalGuardians) {
      const guardianId = guardian[0] as string;
      const email = guardian[6] as string | null;
      if (!email || !guardianRoleId) continue;
      const userId = uuidv7();
      await client.query(
        `insert into users (id, tenant_id, email, phone, password_hash, full_name_en, full_name_bn, locale, status, email_verified_at)
         values ($1,$2,$3,$4,$5,$6,$7,'bn','active',now())`,
        [userId, tenantId, email, guardian[5], passwordHash, guardian[3], guardian[4]],
      );
      await client.query('update guardians set user_id = $1 where id = $2', [userId, guardianId]);
      await client.query(
        `insert into user_roles (id, tenant_id, user_id, role_id, institution_id) values ($1,$2,$3,$4,$5)`,
        [uuidv7(), tenantId, userId, guardianRoleId, institutionId],
      );
    }

    await insertMany(
      client,
      'user_roles',
      ['id', 'tenant_id', 'user_id', 'role_id', 'institution_id', 'campus_id'],
      userRoleRows,
    );

    // ── Academic calendar ─────────────────────────────────────────────────────────────
    // Real Bangladeshi holidays, so attendance and working-day calculations are exercised
    // against a calendar with the right density of closures.
    await insertMany(
      client,
      'calendar_events',
      [
        'id',
        'tenant_id',
        'institution_id',
        'academic_year_id',
        'title_en',
        'title_bn',
        'kind',
        'start_date',
        'end_date',
        'is_non_teaching',
      ],
      [
        [
          uuidv7(),
          tenantId,
          institutionId,
          academicYearId,
          'International Mother Language Day',
          'আন্তর্জাতিক মাতৃভাষা দিবস',
          'holiday',
          `${ACADEMIC_YEAR}-02-21`,
          `${ACADEMIC_YEAR}-02-21`,
          true,
        ],
        [
          uuidv7(),
          tenantId,
          institutionId,
          academicYearId,
          'Independence Day',
          'স্বাধীনতা দিবস',
          'holiday',
          `${ACADEMIC_YEAR}-03-26`,
          `${ACADEMIC_YEAR}-03-26`,
          true,
        ],
        [
          uuidv7(),
          tenantId,
          institutionId,
          academicYearId,
          'Pahela Baishakh',
          'পহেলা বৈশাখ',
          'holiday',
          `${ACADEMIC_YEAR}-04-14`,
          `${ACADEMIC_YEAR}-04-14`,
          true,
        ],
        [
          uuidv7(),
          tenantId,
          institutionId,
          academicYearId,
          'May Day',
          'মে দিবস',
          'holiday',
          `${ACADEMIC_YEAR}-05-01`,
          `${ACADEMIC_YEAR}-05-01`,
          true,
        ],
        [
          uuidv7(),
          tenantId,
          institutionId,
          academicYearId,
          'Summer Vacation',
          'গ্রীষ্মকালীন ছুটি',
          'vacation',
          `${ACADEMIC_YEAR}-06-01`,
          `${ACADEMIC_YEAR}-06-15`,
          true,
        ],
        [
          uuidv7(),
          tenantId,
          institutionId,
          academicYearId,
          'Victory Day',
          'বিজয় দিবস',
          'holiday',
          `${ACADEMIC_YEAR}-12-16`,
          `${ACADEMIC_YEAR}-12-16`,
          true,
        ],
        [
          uuidv7(),
          tenantId,
          institutionId,
          academicYearId,
          'Annual Sports Day',
          'বার্ষিক ক্রীড়া প্রতিযোগিতা',
          'event',
          `${ACADEMIC_YEAR}-11-20`,
          `${ACADEMIC_YEAR}-11-20`,
          false,
        ],
      ],
    );

    await client.query('commit');

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\nSeeded in ${elapsed}s:`);
    console.log(`  Organization : Dhaka Future Academy (${DEMO_TENANT_SLUG})`);
    console.log(`  Institution  : 1, Campus: 1, Shifts: 2`);
    console.log(`  Classes      : ${CLASS_LEVELS.length}, Sections: ${seededSections.length}`);
    console.log(`  Subjects     : ${SUBJECTS.length}, Curriculum rows: ${classSubjectRows.length}`);
    console.log(`  Staff        : ${staffSpecs.length}`);
    console.log(`  Students     : ${studentRows.length}`);
    console.log(
      `  Guardians    : ${guardianRows.length} (${linkRows.length - guardianRows.length} siblings share one)`,
    );
    console.log(`\nDemo sign-in (password for every account: ${DEMO_PASSWORD})`);
    console.log('  owner@dhakafuture.test        School Owner');
    console.log('  principal@dhakafuture.test    Principal');
    console.log('  admin@dhakafuture.test        Administrator');
    console.log('  accountant@dhakafuture.test   Accountant');
    console.log('  controller@dhakafuture.test   Examination Controller');
    console.log('  teacher1@dhakafuture.test     Class Teacher (sees only their own section)');
    console.log('  parent1@dhakafuture.test      Guardian (sees only their own children)');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`\nSeed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
