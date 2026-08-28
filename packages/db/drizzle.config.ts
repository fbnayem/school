import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit is used only to *author* DDL, not to apply it.
 *
 * `out` points at a staging directory holding drizzle-kit's snapshots and generated SQL.
 * Curated migrations live in `./migrations` and are applied by `src/migrator.ts`, which also
 * runs the hand-written RLS, role and grant migrations that the schema DSL cannot express.
 * `scripts/promote-migration.ts` moves a freshly generated file into `./migrations` with the
 * next sequence number.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle/_kit',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://shikkha_app:shikkha@localhost:5432/shikkha_dev',
  },
  verbose: true,
  strict: true,
});
