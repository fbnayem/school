#!/usr/bin/env tsx
/**
 * Drop and rebuild the database from migrations.
 *
 * Refuses to run when NODE_ENV is production, and refuses when the connection string does
 * not look like a local development or test database. Losing a school's records to a
 * mistyped environment variable is not a recoverable error.
 */

import { resolve } from 'node:path';
import { Client } from 'pg';
import { migrate } from '../migrator';

const MIGRATIONS_DIR = resolve(__dirname, '../../migrations');

const SAFE_HOST_PATTERN =
  /@(localhost|127\.0\.0\.1|postgres|shikkha-postgres|host\.docker\.internal)[:/]/;

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('Set MIGRATION_DATABASE_URL or DATABASE_URL.');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('db:reset is refused when NODE_ENV=production.');
    process.exit(1);
  }
  if (!SAFE_HOST_PATTERN.test(url) && process.env.ALLOW_REMOTE_RESET !== 'yes-i-am-sure') {
    console.error(
      'Refusing to reset a database that is not on localhost.\n' +
        'If this really is a disposable environment, set ALLOW_REMOTE_RESET=yes-i-am-sure.',
    );
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    console.log('dropping schema public');
    // CASCADE also removes the policies, functions and triggers created by the migrations.
    await client.query('drop schema public cascade');
    await client.query('create schema public');
    await client.query('grant usage on schema public to shikkha_app, shikkha_readonly');
  } finally {
    await client.end();
  }

  const result = await migrate({
    connectionString: url,
    migrationsDir: MIGRATIONS_DIR,
    log: (message) => console.log(message),
  });
  console.log(`\nRebuilt from ${result.applied.length} migration(s).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
