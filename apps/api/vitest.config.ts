import { defineConfig } from 'vitest/config';
import type { PluginOption } from 'vite';
import { swcIsUsable, typescriptTransform } from './vitest-ts-transform';

/**
 * Base configuration, shared by every project in `vitest.workspace.ts`.
 *
 * NestJS depends on `emitDecoratorMetadata` for constructor injection, and esbuild — which
 * Vitest uses by default — does not implement it. Without a transform that does, every guard
 * and service resolves its dependencies as `undefined`, and the suite fails with "Cannot read
 * properties of undefined", which looks like a DI bug rather than a build one.
 *
 * SWC is that transform when its native binding loads, and TypeScript's own `transpileModule`
 * when it does not — see `vitest-ts-transform.ts` for why a native binary is not something a
 * test suite should require. The choice is made once, at config load, and announced: a run
 * that is quietly using the slower path should say so rather than leaving someone to wonder
 * why the suite got slower.
 */
async function transform(): Promise<PluginOption> {
  if (await swcIsUsable()) {
    const swc = await import('unplugin-swc');
    return swc.default.vite({ module: { type: 'es6' } });
  }
  console.warn(
    '[vitest] SWC’s native binding could not be loaded; falling back to the TypeScript ' +
      'transform. The suite is correct but slower. See apps/api/vitest-ts-transform.ts.',
  );
  return typescriptTransform();
}

export default defineConfig(async () => {
  const plugin = await transform();
  const usingSwc = await swcIsUsable();

  return {
    plugins: [plugin],
    /**
     * Vite runs esbuild over the transform's output unless told not to, and esbuild rewrites
     * TypeScript's decorator emit — `let X = class X {}` — by renaming the inner binding to
     * `X2` to avoid the shadow. `X.name` then reads "X2" for every decorated class in the
     * application, which breaks anything keyed on a class name. It cost an afternoon to find,
     * because 1,398 tests still passed: Nest resolves providers by identity, not by name, so
     * only the one policy that matches on `Class.name` noticed.
     *
     * Left on under SWC because unplugin-swc already suppresses it for the files it handles.
     */
    esbuild: usingSwc ? undefined : (false as const),
    test: {
      globals: true,
      environment: 'node',
      // A cold Postgres connection plus the migration check can genuinely take a few seconds.
      hookTimeout: 60_000,
      testTimeout: 30_000,
    },
  };
});
