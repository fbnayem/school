import { defineConfig } from 'vitest/config';

/**
 * Schema conformance runs without a database — it introspects the Drizzle schema — so it is a
 * unit test and belongs on every commit. Integration coverage of the migrations and RLS lives
 * in `apps/api/test/security`, where there is an application to exercise them through.
 */
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.spec.ts'] },
});
