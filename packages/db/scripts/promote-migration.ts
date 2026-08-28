#!/usr/bin/env tsx
/**
 * Move the newest drizzle-kit output into `migrations/` with the next sequence number.
 *
 * drizzle-kit authors DDL into `drizzle/_kit`; `migrations/` is the curated, ordered set that
 * `src/migrator.ts` actually applies, and it also contains hand-written SQL (RLS, roles,
 * grants, triggers) that the schema DSL cannot express. Keeping the two apart is what lets
 * both coexist without drizzle-kit renumbering over a hand-written file.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const KIT_DIR = resolve(here, '../drizzle/_kit');
const MIGRATIONS_DIR = resolve(here, '../migrations');

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: pnpm promote <descriptive_name>');
    process.exit(1);
  }

  const kitFiles = (await readdir(KIT_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const newest = kitFiles.at(-1);
  if (!newest) {
    console.error(`No generated SQL found in ${KIT_DIR}. Run "pnpm generate" first.`);
    process.exit(1);
  }

  const existing = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const lastNumber = existing.length ? Number(existing.at(-1)!.slice(0, 4)) : 0;
  const next = String(lastNumber + 1).padStart(4, '0');
  const target = join(MIGRATIONS_DIR, `${next}_${name}.sql`);

  const sql = await readFile(join(KIT_DIR, newest), 'utf8');
  await writeFile(target, sql, 'utf8');
  console.log(`Promoted ${newest} -> migrations/${next}_${name}.sql`);
  console.log('Review it before committing. Hand-written SQL belongs in a separate migration.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
