/**
 * Tenant and institution scope resolution.
 *
 * The single most important line in this file is that `tenantId` comes from
 * `principal.tenantId` — the authenticated session — and never from a header, query parameter
 * or body field. A client cannot name its own tenant. Everything else here is about the
 * *institution* scope, which is a different question.
 *
 * Institution is client-supplied, because a group administrator legitimately switches between
 * the schools they administer. It is therefore validated against the principal's accessible
 * institutions before it is trusted, and an unrecognised value is refused rather than ignored.
 */

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { accessibleInstitutionIds, type Principal } from '@shikkha/permissions';
import { isUuid } from '@shikkha/shared';
import { PUBLIC_KEY, SCOPE_KEY } from '../decorators';
import { attachScope, currentContext } from '../context/request-context';
import { SecurityEventService } from '../../modules/audit/security-event.service';

export const INSTITUTION_HEADER = 'x-institution-id';
export const CAMPUS_HEADER = 'x-campus-id';

@Injectable()
export class TenantGuard implements CanActivate {
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

    const request = context.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const principal = request.principal;
    if (!principal) return false; // JwtAuthGuard runs first and would already have refused.

    // Platform staff have no tenant. They may still act inside one when a tenant is named,
    // which is what makes support workflows possible — and every such action is audited.
    if (!principal.tenantId && !principal.isPlatformAdmin) {
      throw new ForbiddenException('This account is not associated with an organization');
    }

    const requestedInstitution = headerValue(request, INSTITUTION_HEADER);
    const requestedCampus = headerValue(request, CAMPUS_HEADER);

    if (requestedInstitution && !isUuid(requestedInstitution)) {
      throw new BadRequestException(`${INSTITUTION_HEADER} must be a UUID`);
    }
    if (requestedCampus && !isUuid(requestedCampus)) {
      throw new BadRequestException(`${CAMPUS_HEADER} must be a UUID`);
    }

    if (requestedInstitution) {
      const allowed = accessibleInstitutionIds(principal);
      // `null` means every institution in the tenant — an owner or a platform admin.
      const permitted = allowed === null || allowed.includes(requestedInstitution);
      if (!permitted) {
        // Recorded as a security event: a client asking for an institution it has no grant
        // for is either a bug in the UI's institution switcher or an enumeration attempt.
        await this.securityEvents.record({
          eventType: 'cross_tenant_attempt',
          severity: 'warning',
          userId: principal.userId,
          tenantId: principal.tenantId,
          detail: { requestedInstitution, path: currentContext()?.path },
        });
        // 404-shaped message: confirming the institution exists elsewhere is itself a leak.
        throw new ForbiddenException('The requested institution is not available to you');
      }
    }

    const scopeRequirement = this.reflector.getAllAndOverride<string>(SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (scopeRequirement === 'institution' && !requestedInstitution) {
      throw new BadRequestException(
        `This endpoint operates within one institution. Send the ${INSTITUTION_HEADER} header.`,
      );
    }

    attachScope(requestedInstitution, requestedCampus);
    return true;
  }
}

function headerValue(request: Request, name: string): string | null {
  const raw = request.headers[name];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw[0]?.trim()) return raw[0].trim();
  return null;
}
