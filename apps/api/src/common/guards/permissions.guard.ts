/**
 * Authorization guard.
 *
 * Evaluates `@RequirePermissions(...)` against the principal, in the institution/campus scope
 * the tenant guard resolved. This is the only place in the API that decides whether an action
 * is allowed; services never re-implement the check, and controllers never inspect role names.
 *
 * A denial is recorded as a security event. A single denial is usually a stale UI; a burst of
 * them from one account is someone probing the permission surface, and that is only visible if
 * they are recorded.
 */

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { canAll, canAny, type Permission, type Principal } from '@shikkha/permissions';
import {
  AUTHENTICATED_KEY,
  PERMISSIONS_KEY,
  PERMISSIONS_MODE_KEY,
  PUBLIC_KEY,
  type PermissionMode,
} from '../decorators';
import { currentContext } from '../context/request-context';
import { SecurityEventService } from '../../modules/audit/security-event.service';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Self-service routes. JwtAuthGuard has already established who the caller is; there is
    // no further question to answer.
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (authenticatedOnly) return true;

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No declared permissions on a non-public route. The boot-time route audit refuses to
    // start in this situation, so reaching here means the audit was bypassed — deny.
    if (!required || required.length === 0) {
      throw new ForbiddenException('This action is not available');
    }

    const mode =
      this.reflector.getAllAndOverride<PermissionMode>(PERMISSIONS_MODE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'all';

    const request = context.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const principal = request.principal;
    if (!principal) return false;

    const ctx = currentContext();
    const accessContext = {
      institutionId: ctx?.institutionId ?? null,
      campusId: ctx?.campusId ?? null,
    };

    const granted =
      mode === 'any'
        ? canAny(principal, required, accessContext)
        : canAll(principal, required, accessContext);

    if (!granted) {
      await this.securityEvents.record({
        eventType: 'permission_denied',
        severity: 'info',
        userId: principal.userId,
        tenantId: principal.tenantId,
        detail: {
          required,
          mode,
          institutionId: accessContext.institutionId,
          method: ctx?.method,
          path: ctx?.path,
        },
      });
      // The message never names the missing permission — that is free reconnaissance.
      throw new ForbiddenException('You do not have permission to perform this action');
    }

    return true;
  }
}
