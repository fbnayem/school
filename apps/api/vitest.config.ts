import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Base configuration, shared by every project in `vitest.workspace.ts`.
 *
 * NestJS depends on `emitDecoratorMetadata` for constructor injection, and esbuild — which
 * Vitest uses by default — does not implement it. Without the SWC transform, every guard and
 * service resolves its dependencies as `undefined`, and the suite fails with
 * "Cannot read properties of undefined", which looks like a DI bug rather than a build one.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    // A cold Postgres connection plus the migration check can genuinely take a few seconds.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
