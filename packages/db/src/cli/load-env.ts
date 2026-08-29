/**
 * Load the repository's `.env` for the database CLIs.
 *
 * The API is started by Nest, which loads `.env` itself; these scripts are run directly by
 * tsx and were not, so `pnpm db:migrate` — a command the README documents bare — failed with
 * "No database URL" on a clean shell. Every documented command has to work as documented.
 *
 * An already-exported variable always wins, matching `node --env-file` semantics, so the
 * deployment form `MIGRATION_DATABASE_URL=... pnpm db:migrate` still overrides the file and a
 * CI environment is never silently replaced by a developer's local settings.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Repository root, relative to `packages/db/src/cli` (and `packages/db/dist/cli`). */
const CANDIDATES = ['../../../../.env', '../../../.env'];

export function loadRepoEnv(): void {
  for (const candidate of CANDIDATES) {
    const path = resolve(__dirname, candidate);
    if (!existsSync(path)) continue;
    // Available since Node 20.12. Does not override variables already in the environment.
    process.loadEnvFile(path);
    return;
  }
}
