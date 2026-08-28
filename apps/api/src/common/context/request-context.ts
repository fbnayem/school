/**
 * Per-request context, carried in an AsyncLocalStorage rather than threaded through every
 * function signature.
 *
 * What lives here is deliberately narrow: the request id, the authenticated principal, and
 * the resolved tenant. These are needed by the logger, the audit interceptor and the database
 * layer — three places that would otherwise each need the request object passed down through
 * services that have no other reason to know about HTTP.
 *
 * What does **not** live here: anything a handler should be receiving as an argument. This is
 * infrastructure plumbing, not a convenient global.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '@shikkha/permissions';

export interface RequestContext {
  requestId: string;
  principal: Principal | null;
  /** Resolved from the principal. Null for unauthenticated and platform-scoped requests. */
  tenantId: string | null;
  /** From `x-institution-id`, validated against the principal's accessible institutions. */
  institutionId: string | null;
  campusId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  method: string;
  path: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current context, or null outside a request (background jobs, boot-time code). */
export function currentContext(): RequestContext | null {
  return storage.getStore() ?? null;
}

export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

export function currentPrincipal(): Principal | null {
  return storage.getStore()?.principal ?? null;
}

export function currentTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}

/**
 * Attach the principal once authentication succeeds.
 *
 * Mutating the stored object rather than re-running the storage is intentional: the guard
 * runs inside the same async context as the handler, so a nested `run` would create a second
 * context that the outer interceptors could not see.
 */
export function attachPrincipal(principal: Principal): void {
  const context = storage.getStore();
  if (!context) return;
  context.principal = principal;
  context.tenantId = principal.tenantId;
}

export function attachScope(institutionId: string | null, campusId: string | null): void {
  const context = storage.getStore();
  if (!context) return;
  context.institutionId = institutionId;
  context.campusId = campusId;
}
