/**
 * Route metadata decorators.
 *
 * The important design point: **a route is protected unless it says otherwise, and it must
 * declare what it needs.** `assertRoutesProtected` (in `common/route-audit.ts`) walks every
 * registered route at boot and refuses to start unless it carries `@Public()`,
 * `@Authenticated()`, or `@RequirePermissions(...)`. Forgetting a guard is therefore a startup
 * crash in every environment, rather than an authorization hole discovered in production.
 */

import { applyDecorators, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Permission, Principal } from '@shikkha/permissions';
import type { RequestContext } from '../context/request-context';

export const PUBLIC_KEY = 'shikkha:public';
export const AUTHENTICATED_KEY = 'shikkha:authenticated';
export const PERMISSIONS_KEY = 'shikkha:permissions';
export const PERMISSIONS_MODE_KEY = 'shikkha:permissions-mode';
export const AUDIT_KEY = 'shikkha:audit';
export const SCOPE_KEY = 'shikkha:scope';

/**
 * No authentication required. The only way to be unauthenticated.
 *
 * Every use should be obvious on inspection: login, refresh, password reset, health,
 * and the public admission form.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Any authenticated user, with no further permission.
 *
 * Reserved for genuine self-service: reading your own profile, ending your own session,
 * changing your own password. These are not permissions anyone could sensibly be denied, and
 * expressing them as one would mean inventing a `self.view` that every role must carry.
 *
 * It satisfies the boot-time route audit, so a route still cannot silently ship with no
 * access declaration at all — it has to say "authenticated is enough", in writing.
 */
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);

export type PermissionMode = 'all' | 'any';

/**
 * Require permissions. Multiple permissions default to requiring **all** of them; pass
 * `{ mode: 'any' }` for a disjunction.
 *
 * `all` is the default because it is the safer reading of an ambiguous declaration.
 */
export function RequirePermissions(
  ...args: [...Permission[]] | [...Permission[], { mode: PermissionMode }]
) {
  const last = args.at(-1);
  const hasOptions = typeof last === 'object' && last !== null && 'mode' in last;
  const mode: PermissionMode = hasOptions ? (last as { mode: PermissionMode }).mode : 'all';
  const permissions = (hasOptions ? args.slice(0, -1) : args) as Permission[];

  return applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSIONS_MODE_KEY, mode),
  );
}

export interface AuditMetadata {
  module: string;
  resourceType: string;
  action:
    | 'create'
    | 'update'
    | 'archive'
    | 'restore'
    | 'approve'
    | 'reject'
    | 'publish'
    | 'unpublish'
    | 'export'
    | 'import'
    | 'payment'
    | 'refund'
    | 'permission_change';
  /** Where to find the resource id in the request — a param name, or a response field. */
  resourceIdFrom?: 'param:id' | 'response:id' | 'body:id';
  /**
   * Refuse the request unless the body carries a non-empty `reason`. Used for actions where
   * "why" is part of the record: attendance corrections, mark changes, refunds, fee waivers.
   */
  requiresReason?: boolean;
}

/** Record this action in the immutable audit log. */
export const Audited = (metadata: AuditMetadata) => SetMetadata(AUDIT_KEY, metadata);

/**
 * Declare that a route operates within an institution, so `TenantGuard` requires and
 * validates the `x-institution-id` header instead of leaving the scope ambiguous.
 */
export const InstitutionScoped = () => SetMetadata(SCOPE_KEY, 'institution');

/** The authenticated principal. Never null on a non-public route — the guard guarantees it. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<{ principal?: Principal }>();
    if (!request.principal) {
      // Reaching here means a route used @CurrentUser() without authentication, which the
      // boot-time route audit should have caught. Failing loudly beats returning undefined.
      throw new Error('CurrentUser used on a route with no authenticated principal');
    }
    return request.principal;
  },
);

/** The resolved request context: request id, tenant, institution scope, client metadata. */
export const Ctx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestContext => {
    const request = context.switchToHttp().getRequest<{ context: RequestContext }>();
    return request.context;
  },
);

/** The resolved tenant id. Throws rather than returning null, so services need no null check. */
export const TenantId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<{ context?: RequestContext }>();
    const tenantId = request.context?.tenantId;
    if (!tenantId) {
      throw new Error('TenantId used on a route with no resolved tenant');
    }
    return tenantId;
  },
);
