/**
 * The early-warning request schemas, re-exported from their module path.
 *
 * Same reason as `early-warning.tables.ts`: `packages/validation/src/index.ts` is wired by the
 * release orchestrator, not by this module. One import site, so the cleanup after wiring is one
 * line.
 */

export * from '@shikkha/validation/dist/early-warning';
