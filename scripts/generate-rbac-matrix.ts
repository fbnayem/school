#!/usr/bin/env tsx
/**
 * Generate `docs/05_RBAC_PERMISSION_MATRIX.md` from the permission catalogue.
 *
 * Hand-written permission documentation is wrong within a month — a role gets a permission in
 * code and nobody updates the table, and the document that auditors and administrators rely on
 * quietly starts lying about who can do what. Generating it means the document is either
 * correct or the build is broken.
 *
 *   pnpm docs:rbac
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ALL_PERMISSIONS,
  ALWAYS_AUDITED_PERMISSIONS,
  can,
  PERMISSION_CATALOG,
  PRIVILEGE_ESCALATING_PERMISSIONS,
  SYSTEM_ROLES,
  type Principal,
} from '@shikkha/permissions';

const OUTPUT = resolve(__dirname, '../docs/05_RBAC_PERMISSION_MATRIX.md');

function principalFor(roleKey: string): Principal {
  const role = SYSTEM_ROLES.find((r) => r.key === roleKey)!;
  return {
    userId: 'doc',
    tenantId: 'doc',
    isPlatformAdmin: false,
    roles: [
      {
        roleId: 'doc',
        roleKey,
        permissions: role.permissions,
        institutionIds: null,
        campusIds: null,
      },
    ],
  };
}

function main(): Promise<void> {
  const holders = new Map<string, string[]>();
  for (const permission of ALL_PERMISSIONS) {
    holders.set(
      permission,
      SYSTEM_ROLES.filter((role) => can(principalFor(role.key), permission)).map((r) => r.key),
    );
  }

  const lines: string[] = [];

  lines.push('# 05 — RBAC and Permission Matrix');
  lines.push('');
  lines.push(
    '> **Generated file.** Produced by `scripts/generate-rbac-matrix.ts` from',
    '> `packages/permissions`. Do not edit by hand — run `pnpm docs:rbac` after changing a role',
    '> or the permission catalogue.',
  );
  lines.push('');
  lines.push(
    `Permissions: **${ALL_PERMISSIONS.length}** · System roles: **${SYSTEM_ROLES.length}**`,
  );
  lines.push('');

  lines.push('## How authorization works');
  lines.push('');
  lines.push(
    'Permission strings are the only authorization vocabulary in the system (ADR-005). Guards',
    'check permissions; nothing checks a role name. Roles are rows in the `roles` table carrying',
    'a set of permission strings, so a school can create "Senior Coordinator" without a code',
    'change.',
  );
  lines.push('');
  lines.push(
    'A grant may use a trailing wildcard (`students.*`, or bare `*` for the owner). Requests are',
    'always concrete. Wildcards match at segment boundaries only, so `student.*` does **not**',
    'cover `students.view.all`.',
  );
  lines.push('');
  lines.push('### Scoped permissions');
  lines.push('');
  lines.push(
    'Where a resource means something different depending on whose records are involved, the',
    'distinction is in the permission rather than left to each service:',
  );
  lines.push('');
  lines.push('| Suffix | Meaning |');
  lines.push('| --- | --- |');
  lines.push('| `.all` | Every record in the accessible institutions |');
  lines.push('| `.assigned` | Only records connected to the employee — sections they teach |');
  lines.push('| `.own` | Only the caller’s own records, or their linked children |');
  lines.push('');
  lines.push(
    'The guard decides *which* filter applies; the repository applies it. A guard cannot answer',
    '"is this row one of their students" without a database join, so conflating the two produces',
    'endpoints that check a permission and then return every row.',
  );
  lines.push('');

  // ── Roles ───────────────────────────────────────────────────────────────────────────
  lines.push('## System roles');
  lines.push('');
  lines.push('| Role | Key | Audience | Sensitive | Permissions | Description |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const role of SYSTEM_ROLES) {
    const count = ALL_PERMISSIONS.filter((p) => can(principalFor(role.key), p)).length;
    lines.push(
      `| ${role.nameEn} | \`${role.key}\` | ${role.audience} | ${role.sensitive ? 'Yes' : 'No'} | ${count} | ${role.description} |`,
    );
  }
  lines.push('');

  // ── Matrix by module ────────────────────────────────────────────────────────────────
  lines.push('## Permission matrix');
  lines.push('');
  lines.push(
    'A tick means the shipped preset grants the permission. Tenants may edit these, so this is',
    'the starting point, not a guarantee about a live deployment.',
  );
  lines.push('');

  const shortNames = SYSTEM_ROLES.map((role) => abbreviate(role.key));
  lines.push(
    'Column keys: ' + SYSTEM_ROLES.map((r, i) => `\`${shortNames[i]}\` ${r.nameEn}`).join(' · '),
  );
  lines.push('');

  for (const [group, permissions] of Object.entries(PERMISSION_CATALOG)) {
    lines.push(`### ${titleCase(group)}`);
    lines.push('');
    lines.push(`| Permission | ${shortNames.join(' | ')} |`);
    lines.push(`| --- | ${shortNames.map(() => '---').join(' | ')} |`);
    for (const permission of permissions) {
      const granted = SYSTEM_ROLES.map((role) =>
        holders.get(permission)!.includes(role.key) ? '●' : '',
      );
      lines.push(`| \`${permission}\` | ${granted.join(' | ')} |`);
    }
    lines.push('');
  }

  // ── Separation of duties ────────────────────────────────────────────────────────────
  lines.push('## Separation of duties');
  lines.push('');
  lines.push(
    'These pairings are deliberate and are asserted by `packages/permissions/test/rbac-matrix.spec.ts`.',
    'Weakening one should mean changing the test with an explanation, not quietly widening a preset.',
  );
  lines.push('');
  lines.push('| Action | Performed by | Approved by |');
  lines.push('| --- | --- | --- |');
  lines.push(
    `| Refund | ${listHolders(holders, 'finance.refund')} | ${listHolders(holders, 'finance.refund.approve')} |`,
  );
  lines.push(
    `| Discount | ${listHolders(holders, 'finance.discounts.manage')} | ${listHolders(holders, 'finance.discounts.approve')} |`,
  );
  lines.push(
    `| Journal entry | ${listHolders(holders, 'accounting.journal.create')} | ${listHolders(holders, 'accounting.journal.post')} |`,
  );
  lines.push(
    `| Marks | ${listHolders(holders, 'results.enter_marks')} | ${listHolders(holders, 'results.approve')} |`,
  );
  lines.push(
    `| Results publication | ${listHolders(holders, 'results.submit_marks')} | ${listHolders(holders, 'results.publish')} |`,
  );
  lines.push(
    `| Payroll run | ${listHolders(holders, 'payroll.runs.create')} | ${listHolders(holders, 'payroll.runs.approve')} |`,
  );
  lines.push(
    `| Attendance correction | ${listHolders(holders, 'attendance.correct')} | ${listHolders(holders, 'attendance.correct.approve')} |`,
  );
  lines.push('');

  // ── Escalation and audit ────────────────────────────────────────────────────────────
  lines.push('## Privilege-escalating permissions');
  lines.push('');
  lines.push(
    'These can create or widen access, or move money without a second pair of eyes. They may only',
    'be granted by a principal who already holds them, which stops a mid-level administrator from',
    'writing themselves a role that can issue refunds.',
  );
  lines.push('');
  lines.push('| Permission | Held by |');
  lines.push('| --- | --- |');
  for (const permission of PRIVILEGE_ESCALATING_PERMISSIONS) {
    lines.push(`| \`${permission}\` | ${listHolders(holders, permission)} |`);
  }
  lines.push('');

  lines.push('## Always-audited permissions');
  lines.push('');
  lines.push(
    'Exercising any of these writes an immutable audit record regardless of what the route',
    'declares, so a new endpoint cannot ship unaudited.',
  );
  lines.push('');
  for (const permission of ALWAYS_AUDITED_PERMISSIONS) {
    lines.push(`- \`${permission}\``);
  }
  lines.push('');

  // ── Unheld permissions ──────────────────────────────────────────────────────────────
  const unheld = ALL_PERMISSIONS.filter((p) => holders.get(p)!.length === 0);
  if (unheld.length > 0) {
    lines.push('## Permissions no default role holds');
    lines.push('');
    lines.push(
      'Reachable only through a custom role. Usually correct — these are either platform-level or',
      'deliberately reserved — but worth reviewing when adding a permission.',
    );
    lines.push('');
    for (const permission of unheld) lines.push(`- \`${permission}\``);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString().slice(0, 10)} from \`packages/permissions\`.`);
  lines.push('');

  return writeFile(OUTPUT, lines.join('\n'), 'utf8').then(() => {
    console.log(`Wrote ${OUTPUT}`);
    console.log(
      `  ${ALL_PERMISSIONS.length} permissions, ${SYSTEM_ROLES.length} roles, ${unheld.length} unheld`,
    );
  });
}

function listHolders(holders: Map<string, string[]>, permission: string): string {
  const list = holders.get(permission) ?? [];
  return list.length > 0 ? list.map((key) => `\`${key}\``).join(', ') : '_nobody by default_';
}

/** Short column headers, so a 22-column table is still readable in a terminal. */
function abbreviate(key: string): string {
  return key
    .split('_')
    .map((part) => part.slice(0, 2))
    .join('')
    .toUpperCase()
    .slice(0, 4);
}

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
