import { defineWorkspace } from 'vitest/config';

/**
 * Three projects, because they have genuinely different requirements:
 *
 *  - `unit`        — no I/O. Runs anywhere, on every commit, in milliseconds.
 *  - `integration` — needs a real PostgreSQL. Single-threaded: the suites share one database
 *                    and parallel truncation is a race that produces confusing failures.
 *  - `security`    — tenant isolation and RBAC. Same database requirement, kept separate so it
 *                    can be run and reported independently: a failure here blocks a release,
 *                    while a failing integration test is an ordinary bug.
 */
export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: { name: 'unit', include: ['test/unit/**/*.spec.ts'] },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['test/integration/**/*.spec.ts'],
      fileParallelism: false,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'security',
      include: ['test/security/**/*.spec.ts'],
      fileParallelism: false,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
