/**
 * The complete database schema.
 *
 * Import order matters only for readability; Drizzle resolves references lazily. Every table
 * that holds business data carries `tenant_id` — the conformance test in
 * `test/schema-conformance.spec.ts` fails the build if a new table forgets it.
 */

export * from './_shared';
export * from './tenancy';
export * from './identity';
export * from './audit';
export * from './files';
export * from './academic';
export * from './people';
export * from './students';
