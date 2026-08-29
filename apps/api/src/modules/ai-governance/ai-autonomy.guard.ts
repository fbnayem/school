/**
 * The autonomy boundary, enforced.
 *
 * One rule: **an AI-initiated request may not reach a route that performs a forbidden
 * autonomous action.** docs/06 §6 lists nine of them; `ai-autonomy.policy.ts` holds the list
 * as data; this guard is the place a request is actually refused.
 *
 * ── Why a guard and not a check inside each service ────────────────────────────────────
 *
 * Because the rule is about *reaching* the action, not about performing it. A check inside
 * `PayrollService.approveRun` protects one method; the next method somebody adds is
 * unprotected and nothing says so. A guard reading route metadata protects every route that
 * declares itself, including routes written after this file, and the attestation endpoint can
 * enumerate exactly which ones those are. Same argument as `common/route-audit.ts`: the way an
 * authorization hole ships is not a wrong check, it is a missing one.
 *
 * ── Registration and ordering ──────────────────────────────────────────────────────────
 *
 * Registered as an `APP_GUARD` from `AiGovernanceModule`, so it applies to every route in the
 * application without any controller opting in. Nest resolves `APP_GUARD` providers in module
 * instantiation order, which means this guard may run **before** `JwtAuthGuard` has attached a
 * principal. It is written not to care: the decision depends only on the route's own metadata
 * and on whether the request declared itself AI-initiated, so an unauthenticated AI-initiated
 * request to a payroll route is refused with the same 403 as an authenticated one. Depending
 * on guard ordering for correctness would be a defect waiting for a refactor.
 *
 * ── Reads are never refused ────────────────────────────────────────────────────────────
 *
 * GET is untouched. The whole design of the AI surface is that a model may read what its user
 * may read (docs/06 §2) and may write nothing; refusing reads here would break the copilot and
 * defend nothing. `POST` routes that are really reads — `fees/invoices/preview`,
 * `communication/campaigns/:id/preview-recipients` — are refused when they match the policy,
 * and that is the intended direction: previewing the recipients of a mass campaign is a step
 * of a mass campaign.
 *
 * ── What a refusal looks like ──────────────────────────────────────────────────────────
 *
 * 403 `FORBIDDEN` with a fixed, quotable message. Not a 404: unlike the tool surface, there is
 * no existence to conceal — the caller is a legitimate authenticated user (or the gateway
 * acting for one) hitting a documented route, and the useful answer is "a person has to do
 * this". Concealment here would buy nothing and would make a real incident harder to diagnose.
 */

import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import { AUDIT_KEY, PERMISSIONS_KEY, PUBLIC_KEY, type AuditMetadata } from '../../common/decorators';
import { currentContext } from '../../common/context/request-context';
import { SecurityEventService } from '../audit/security-event.service';
import {
  isMutating,
  matchingActions,
  type ForbiddenAutonomousAction,
  type RouteDescriptor,
} from './ai-autonomy.policy';
import {
  aiInitiationOf,
  markAiInitiatedFromHeader,
  type AiInitiation,
  type RequestWithInitiation,
} from './ai-initiation';

/**
 * The refusal, in one string.
 *
 * Exported so `test/security/ai-autonomy-boundary.spec.ts` asserts the boundary rather than a
 * copy of the boundary's wording. It is written for whoever reads it in a support ticket — a
 * teacher looking at an error, not an engineer looking at a log — and it says what to do next,
 * because "forbidden" with no next step is how a control gets routed around.
 */
export const AI_AUTONOMY_REFUSAL_MESSAGE =
  'This action cannot be taken by AI. A person with the right permission has to review it and ' +
  'confirm it themselves.';

@Injectable()
export class AiAutonomyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Non-HTTP execution contexts (there are none today; there will be a queue worker) have
    // no request to read, and a background job is not covered by this guard.
    if (context.getType() !== 'http') return true;

    const request = context
      .switchToHttp()
      .getRequest<RequestWithInitiation & { principal?: Principal }>();

    /**
     * The header is read *here* rather than in middleware, and that is not an accident.
     *
     * Middleware registered from this module would run outside the AsyncLocalStorage that
     * `RequestContextMiddleware` establishes — module middleware is applied before the root
     * module's — so the mirror into the request context would silently be a no-op and every
     * service calling `currentAiInitiation()` would see a human. A guard runs inside that
     * storage, always. `aiInitiationOf` is consulted first so an in-process marker set by an
     * AI feature calling a service directly wins over anything a header claims.
     */
    const initiation = aiInitiationOf(request) ?? markAiInitiatedFromHeader(request);
    // The overwhelmingly common case, and the cheapest: a human asked for this.
    if (!initiation) return true;

    const route = this.describe(context, request.method);
    if (!isMutating(route)) return true;

    const matched = matchingActions(route);
    if (matched.length === 0) return true;

    await this.recordRefusal(request.principal ?? null, route, matched, initiation);
    throw new ForbiddenError(undefined, AI_AUTONOMY_REFUSAL_MESSAGE);
  }

  /**
   * The route, in the shape the policy evaluates.
   *
   * Built from the execution context rather than looked up in `RouteInventoryService`, so the
   * guard has no boot-order dependency on the inventory and no map lookup on the hot path.
   * Both producers build the same `RouteDescriptor` from the same metadata keys, which is what
   * keeps the attestation honest about what the guard will actually do.
   */
  private describe(context: ExecutionContext, httpMethod: string): RouteDescriptor {
    const handler = context.getHandler();
    const controller = context.getClass();

    const isPublic =
      this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, controller]) ?? false;
    const permissions =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [handler, controller]) ?? [];
    const audit =
      this.reflector.getAllAndOverride<AuditMetadata>(AUDIT_KEY, [handler, controller]) ?? null;

    const basePath = (Reflect.getMetadata(PATH_METADATA, controller) as string) ?? '';
    const methodPath = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? '';

    return {
      controller: controller.name,
      handler: handler.name,
      // The request's verb, not the decorator's: a route declared `@All()` still arrives as
      // one concrete method, and that is the one the policy has to judge.
      method: httpMethod.toUpperCase(),
      path: `/${[basePath, methodPath].join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1'),
      permissions: isPublic ? [] : permissions,
      audit: audit
        ? { module: audit.module, resourceType: audit.resourceType, action: audit.action }
        : null,
    };
  }

  /**
   * A refusal is a security event, not an audit record.
   *
   * `audit_logs` answers "what changed"; nothing changed. `security_events` answers "who tried
   * and did it work", which is the question here — and one refusal is a misconfigured
   * integration while fifty in a minute is a model in a loop against the school's payroll.
   *
   * `permission_denied` is the closest of the existing event types; there is no
   * `ai_autonomy_refused` in `SecurityEventService`'s union and inventing one would mean
   * editing a file this module does not own. `detail.reason` carries the real classification
   * so an operator can filter on it, and the gap is reported rather than papered over.
   */
  private async recordRefusal(
    principal: Principal | null,
    route: RouteDescriptor,
    matched: readonly ForbiddenAutonomousAction[],
    initiation: AiInitiation,
  ): Promise<void> {
    const ctx = currentContext();
    await this.securityEvents.record({
      eventType: 'permission_denied',
      // Critical rather than info: an ordinary permission denial is usually a stale UI, and
      // this one cannot be. Something declared itself to be acting for a model and then tried
      // to change a grade, issue a refund or run payroll.
      severity: 'critical',
      userId: principal?.userId ?? null,
      tenantId: principal?.tenantId ?? null,
      detail: {
        reason: 'ai_autonomy_boundary',
        forbiddenActions: matched.map((action) => action.key),
        clauses: matched.map((action) => action.clause),
        route: `${route.method} ${route.path}`,
        controller: route.controller,
        handler: route.handler,
        initiatedBy: initiation.declaredBy,
        initiationOrigin: initiation.origin,
        institutionId: ctx?.institutionId ?? null,
        requestId: ctx?.requestId ?? null,
      },
    });
  }
}
