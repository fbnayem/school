#!/usr/bin/env tsx
/**
 * Migration CLI.
 *
 *   pnpm db:migrate               apply pending migrations
 *   pnpm db:migrate -- --status   list applied and pending, change nothing
 *   pnpm db:migrate -- --dry-run  report what would run
 *
 * Connects with MIGRATION_DATABASE_URL when set, falling back to DATABASE_URL. Keeping them
 * separate is what lets the API connect as the unprivileged `shikkha_app` role while
 * migrations run as the owner — the arrangement RLS depends on.
 */

import { resolve } from 'node:path';
import { migrate, migrationStatus } from '../migrator';
import { loadRepoEnv } from './load-env';

loadRepoEnv();

// The package compiles to CommonJS, so `__dirname` is the portable form here; `import.meta`
// would only work under an ESM build and this script runs both via tsx and from dist/.
const MIGRATIONS_DIR = resolve(__dirname, '../../migrations');

function connectionString(): string {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'No database URL. Set MIGRATION_DATABASE_URL (preferred, owner role) or DATABASE_URL.\n' +
        'For the Docker development stack:\n' +
        '  MIGRATION_DATABASE_URL=postgres://shikkha_migrator:shikkha_dev_password@localhost:5433/shikkha_dev',
    );
    process.exit(1);
  }
  return url;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const url = connectionString();

  if (args.has('--status')) {
    const status = await migrationStatus(url, MIGRATIONS_DIR);
    console.log(`Applied (${status.applied.length}):`);
    for (const record of status.applied) {
      console.log(`  ${record.name}  ${record.appliedAt.toISOString()}  ${record.durationMs}ms`);
    }
    console.log(`\nPending (${status.pending.length}):`);
    for (const name of status.pending) console.log(`  ${name}`);
    return;
  }

  const result = await migrate({
    connectionString: url,
    migrationsDir: MIGRATIONS_DIR,
    dryRun: args.has('--dry-run'),
    log: (message) => console.log(message),
  });

  if (result.applied.length === 0) {
    console.log(`Nothing to apply. ${result.skipped.length} migration(s) already in place.`);
  } else {
    console.log(
      `\nApplied ${result.applied.length} migration(s); ${result.skipped.length} already in place.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(`\nMigration failed:\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
