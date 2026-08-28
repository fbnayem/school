/**
 * Audit interceptor.
 *
 * Writes an immutable record for routes carrying `@Audited(...)`. Three decisions worth
 * stating, because each prevents a class of useless audit trail:
 *
 *  1. **Only successful actions are audited here.** A failed attempt is a *security* event and
 *     goes to `security_events`, which has a different shape and retention. Mixing them makes
 *     "what changed" impossible to answer without filtering.
 *  2. **The record is written after the handler resolves**, so it can capture the created id
 *     and the resulting state. A record written beforehand would describe an intent that may
 *     never have happened.
 *  3. **Audit failures never fail the request.** If the audit insert throws, the business
 *     action has already committed; rolling the response back would be a lie. It is logged at
 *     error level and surfaced through monitoring instead.
 *
 * Point 3 is a deliberate trade-off. For actions where the audit record is legally part of the
 * transaction — journal postings, mark approvals, refunds — the service writes the audit row
 * inside its own transaction rather than relying on this interceptor.
 */

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type Observable, tap } from 'rxjs';
import { ValidationError } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import { AUDIT_KEY, type AuditMetadata } from '../decorators';
import { currentContext } from '../context/request-context';
import { AuditService } from '../../modules/audit/audit.service';
import { getLogger } from '../logger';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.getAllAndOverride<AuditMetadata>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!metadata) return next.handle();

    const request = context
      .switchToHttp()
      .getRequest<Request & { principal?: Principal; body?: Record<string, unknown> }>();

    // Enforced before the handler runs, so an action that policy says needs a justification
    // cannot be performed and then annotated afterwards.
    if (metadata.requiresReason) {
      const reason = request.body?.['reason'];
      if (typeof reason !== 'string' || reason.trim().length < 3) {
        // A ValidationError, not a BadRequestException: the rest of the API reports invalid
        // input as 422 with a field path, and a client should not have to special-case one
        // endpoint because the check happens in an interceptor rather than a pipe.
        throw new ValidationError('This action requires a reason', [
          {
            path: 'reason',
            message:
              'Give a reason for this action. It is recorded in the audit log and cannot be changed later.',
          },
        ]);
      }
    }

    return next.handle().pipe(
      tap({
        next: (result: unknown) => {
          void this.write(metadata, request, result);
        },
      }),
    );
  }

  private async write(
    metadata: AuditMetadata,
    request: Request & { principal?: Principal; body?: Record<string, unknown> },
    result: unknown,
  ): Promise<void> {
    try {
      const ctx = currentContext();
      const principal = request.principal;

      await this.audit.record({
        tenantId: principal?.tenantId ?? null,
        institutionId: ctx?.institutionId ?? null,
        campusId: ctx?.campusId ?? null,
        actorUserId: principal?.userId ?? null,
        actorRoles: principal?.roles.map((role) => role.roleKey) ?? [],
        action: metadata.action,
        module: metadata.module,
        resourceType: metadata.resourceType,
        resourceId: resolveResourceId(metadata, request, result),
        // `previousValue` is only available when the service captured it; the interceptor
        // cannot read the pre-state without a second query it has no business issuing.
        previousValue: readAuditHint(result, 'previousValue'),
        newValue: readAuditHint(result, 'newValue') ?? redactBody(request.body),
        reason: typeof request.body?.['reason'] === 'string' ? request.body['reason'] : null,
        requestId: ctx?.requestId ?? null,
        ipAddress: ctx?.ipAddress ?? null,
        userAgent: ctx?.userAgent ?? null,
      });
    } catch (error) {
      getLogger().error(
        { err: error, module: metadata.module, resourceType: metadata.resourceType },
        'failed to write audit record — the business action still succeeded',
      );
    }
  }
}

function resolveResourceId(
  metadata: AuditMetadata,
  request: Request,
  result: unknown,
): string | null {
  const source = metadata.resourceIdFrom ?? 'response:id';
  if (source === 'param:id') return (request.params as Record<string, string>)?.['id'] ?? null;
  if (source === 'body:id') {
    const value = (request.body as Record<string, unknown> | undefined)?.['id'];
    return typeof value === 'string' ? value : null;
  }
  const value =
    (result as { id?: unknown; data?: { id?: unknown } })?.id ??
    (result as { data?: { id?: unknown } })?.data?.id;
  return typeof value === 'string' ? value : null;
}

/**
 * Services attach `__audit` to their return value when they have captured before/after state
 * that the interceptor cannot see. The key is stripped from the HTTP response by the
 * serialisation interceptor.
 */
function readAuditHint(result: unknown, key: 'previousValue' | 'newValue'): unknown {
  const hint = (result as { __audit?: Record<string, unknown> })?.__audit;
  return hint?.[key] ?? null;
}

/**
 * Sensitive fields never reach the audit table.
 *
 * The audit log is read by administrators and auditors, exported, and retained for years. A
 * password reset request whose body was captured verbatim would put a plaintext password into
 * a long-lived, widely-readable table.
 */
const NEVER_AUDITED = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'confirmPassword',
  'token',
  'refreshToken',
  'mfaSecret',
  'mfaCode',
  'recoveryCode',
  'secret',
]);

function redactBody(body: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    out[key] = NEVER_AUDITED.has(key) ? '[redacted]' : value;
  }
  return out;
}
