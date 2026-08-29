/**
 * The early-warning tables, re-exported from their module path.
 *
 * `packages/db/src/schema/index.ts` — the barrel every other module imports through — is owned
 * by the release orchestrator, because Phase 34 lands beside four other phases and a
 * concurrent edit to one shared file collides. Until the barrel carries
 * `export * from './early_warning'`, this is the specifier that resolves, and importing it in
 * exactly one place means the eventual cleanup is a one-line change here rather than an edit
 * to every call site.
 *
 * Same physical module either way: the package has no `exports` map, so this path and the
 * barrel both load `dist/schema/early_warning.js`, and the Drizzle table objects are the same
 * singletons the rest of the schema graph references.
 */

export * from '@shikkha/db/dist/schema/early_warning';
