/**
 * A pure-JavaScript TypeScript transform for Vitest, used when SWC's native binding cannot
 * be loaded.
 *
 * The suite's normal transform is `unplugin-swc`, which is fast and correct. It is also a
 * native `.node` binary, and a native binary is a single point of failure this project does
 * not control: on a machine running Windows Application Control (or Smart App Control, or a
 * corporate WDAC policy) loading it fails with
 *
 *     Failed to load native binding
 *     An Application Control policy has blocked this file.
 *
 * and every one of the API's tests becomes unrunnable — not failing, unrunnable, which is
 * worse, because a suite that cannot start proves nothing. The same class of failure appears
 * on an unsupported CPU architecture, in a slim CI container, and after a partial
 * `pnpm install`.
 *
 * TypeScript's own `transpileModule` does the one thing esbuild cannot — `emitDecoratorMetadata`,
 * which NestJS needs for constructor injection — in ordinary JavaScript, with no binary to
 * block. It is slower than SWC, so it is the fallback rather than the default: speed when the
 * binding loads, a suite that still runs when it does not.
 *
 * `useDefineForClassFields` is forced off. With it on, a decorated property declaration emits
 * a `defineProperty` that overwrites what the constructor assigned, and Nest's injected
 * dependencies silently become `undefined` — the same symptom that made the SWC transform
 * necessary in the first place, arriving by a different route.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

/** The API's own compiler options, so the transform matches what `tsc` would produce. */
function compilerOptions(): ts.CompilerOptions {
  const configPath = resolve(here, 'tsconfig.json');
  const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
  const base = ts.convertCompilerOptionsFromJson(
    parsed.config?.compilerOptions ?? {},
    here,
  ).options;

  return {
    ...base,
    // Vite consumes ES modules; the package's own `module` setting targets the Node build.
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    useDefineForClassFields: false,
    // Type errors are `pnpm typecheck`'s job. Transpiling per-file has no type information
    // anyway, so asking for diagnostics here would only produce false ones.
    isolatedModules: true,
    sourceMap: true,
    inlineSources: true,
  };
}

export function typescriptTransform(): Plugin {
  const options = compilerOptions();

  return {
    name: 'shikkha:typescript-transform',
    enforce: 'pre',
    transform(code, id) {
      if (!/\.tsx?$/.test(id) || id.endsWith('.d.ts') || id.includes('node_modules')) return null;
      const output = ts.transpileModule(code, { compilerOptions: options, fileName: id });
      return { code: output.outputText, map: output.sourceMapText ?? null };
    },
  };
}

/**
 * Can SWC's native binding actually load?
 *
 * Importing `@swc/core` is the only honest test — the package resolves fine and then throws
 * when it tries to `dlopen` the platform binary, so a `resolve` check would report success on
 * exactly the machines where this matters.
 */
export async function swcIsUsable(): Promise<boolean> {
  try {
    const swc = await import('@swc/core');
    // `transformSync` is what forces the binding to load. Importing alone can succeed.
    swc.transformSync('const probe = 1;', { jsc: { target: 'es2022' } });
    return true;
  } catch {
    return false;
  }
}
