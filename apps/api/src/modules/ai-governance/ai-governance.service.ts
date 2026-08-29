/**
 * Governance reads: the policy, the attestation, and the AI-initiated trail.
 *
 * Three different readers, which is why there are three shapes rather than one:
 *
 *  - **The policy** is what the school was promised. A list of what AI may never do on its
 *    own, and — the part that makes it checkable rather than reassuring — the routes each
 *    entry actually covers in *this* build.
 *  - **The attestation** is whether the promise currently holds. It walks the router and
 *    reports gaps. A gap is reported as a gap; there is no code path here that can report
 *    compliance without having checked.
 *  - **The AI-initiated trail** is what someone needs when they ask "how was this decided?"
 *    about a specific child, months later. It is `audit_logs` filtered to
 *    `is_ai_initiated`, which is the column migration 0001 added for exactly this question.
 */

import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { auditActionEnum, auditLogs } from '@shikkha/db';
import {
  buildOffsetPage,
  offsetOf,
  type OffsetPage,
  type OffsetPageRequest,
} from '@shikkha/shared';
import { DatabaseService } from '../database/database.service';
import {
  FORBIDDEN_AUTONOMOUS_ACTIONS,
  isMutating,
  matchingActions,
  smellingActions,
  type ForbiddenActionKey,
  type RouteDescriptor,
} from './ai-autonomy.policy';
import { RouteInventoryService } from './route-inventory.service';

/** A route as the policy documents publish it. `RouteDescriptor` with nothing added or hidden. */
export interface PublishedRoute {
  method: string;
  path: string;
  controller: string;
  handler: string;
  permissions: readonly string[];
  audit: RouteDescriptor['audit'];
}

export interface PublishedPolicyEntry {
  key: ForbiddenActionKey;
  clause: string;
  plainLanguage: string;
  humanConfirmation: readonly string[];
  /** Every mutating route in this build that the entry covers. */
  routes: PublishedRoute[];
  routeCount: number;
}

export interface PublishedPolicy {
  source: string;
  enforcedBy: string;
  /** The header a caller uses to declare itself AI-initiated, so an auditor can reproduce a test. */
  initiationHeader: string;
  refusal: { status: number; code: string; message: string };
  actions: PublishedPolicyEntry[];
}

export interface AttestationGap {
  route: PublishedRoute;
  /** Which clauses this route looks like it belongs to, from the independent detector. */
  suspectedActions: ForbiddenActionKey[];
  why: string;
}

export interface Attestation {
  generatedAt: string;
  /**
   * False when any mutating route looks like it touches a forbidden resource and the policy
   * does not cover it. There is no third state and no "compliant with exceptions".
   */
  compliant: boolean;
  statement: string;
  method: string;
  summary: {
    totalRoutes: number;
    mutatingRoutes: number;
    coveredRoutes: number;
    gapCount: number;
    mutatingRoutesWithoutAuditMetadata: number;
  };
  coverage: Array<{ key: ForbiddenActionKey; clause: string; routeCount: number }>;
  gaps: AttestationGap[];
  /**
   * Mutating routes carrying no `@Audited(...)`.
   *
   * Published because the policy can only judge those by permission string and path, which is
   * weaker. `common/route-audit.ts` already prints them at boot; a reader of the attestation
   * should be able to see the same list without access to the logs.
   */
  mutatingRoutesWithoutAuditMetadata: PublishedRoute[];
}

/**
 * The audit action verbs, taken from the database enum rather than restated.
 *
 * Restating them would mean a verb added to the schema silently becomes unfilterable here,
 * and — worse — a typo in a filter would be a value the column can never hold, which returns
 * an empty page that reads exactly like "the AI never did that".
 */
export const AUDIT_ACTIONS = auditActionEnum.enumValues;
export type AuditActionValue = (typeof AUDIT_ACTIONS)[number];

export interface AiActionQuery {
  module?: string;
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  action?: AuditActionValue;
  institutionId?: string | null;
  from?: Date;
  to?: Date;
}

/** What "how was this decided" actually needs. */
export interface AiActionRow {
  id: string;
  occurredAt: Date;
  actorUserId: string | null;
  actorRoles: unknown;
  action: string;
  module: string;
  resourceType: string;
  resourceId: string | null;
  resourceLabel: string | null;
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  requestId: string | null;
  institutionId: string | null;
  isAiInitiated: boolean;
}

@Injectable()
export class AiGovernanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly routes: RouteInventoryService,
  ) {}

  /**
   * The forbidden set, with the routes each entry covers.
   *
   * The route list is the point. "AI may not issue refunds" is a claim; "AI may not issue
   * refunds, and here are the four routes in this build that issue one" is a claim somebody
   * can check against the router, which is what a data protection officer is actually for.
   */
  policy(refusal: { status: number; code: string; message: string }, header: string): PublishedPolicy {
    const mutating = this.routes.all().filter(isMutating);

    return {
      source: 'docs/06_AI_ARCHITECTURE.md §6, as data in ai-governance/ai-autonomy.policy.ts',
      enforcedBy: 'AiAutonomyGuard, registered as an APP_GUARD for every route',
      initiationHeader: header,
      refusal,
      actions: FORBIDDEN_AUTONOMOUS_ACTIONS.map((action) => {
        const routes = mutating
          .filter((route) => matchingActions(route).some((match) => match.key === action.key))
          .map(publish);
        return {
          key: action.key,
          clause: action.clause,
          plainLanguage: action.plainLanguage,
          humanConfirmation: action.humanConfirmation,
          routes,
          routeCount: routes.length,
        };
      }),
    };
  }

  /**
   * Every mutating route, judged twice.
   *
   * A route is **covered** when the policy matches it. A route is a **gap** when the
   * independent detector says it touches one of these resources and the policy does not match
   * it. The two signals are built from different inputs on purpose (see the policy file), so
   * this cannot degenerate into "the policy agrees with itself".
   */
  attestation(): Attestation {
    const all = this.routes.all();
    const mutating = all.filter(isMutating);

    let covered = 0;
    const gaps: AttestationGap[] = [];

    for (const route of mutating) {
      const matched = matchingActions(route);
      if (matched.length > 0) {
        covered += 1;
        continue;
      }
      const suspected = smellingActions(route);
      if (suspected.length === 0) continue;

      gaps.push({
        route: publish(route),
        suspectedActions: suspected.map((action) => action.key),
        why:
          `This route changes state and its path, handler, resource type or permissions match ` +
          `${suspected.map((action) => `"${action.clause}"`).join(', ')}, but no policy entry ` +
          `covers it. AI-initiated requests to it are NOT refused. Either add its permission ` +
          `or audit resource type to the matching entry in ai-autonomy.policy.ts, or record ` +
          `why it is out of scope.`,
      });
    }

    const unaudited = mutating.filter((route) => route.audit === null);
    const compliant = gaps.length === 0;

    return {
      generatedAt: new Date().toISOString(),
      compliant,
      statement: compliant
        ? `Every mutating route that appears to touch a forbidden resource is covered by the ` +
          `autonomy policy. ${covered} of ${mutating.length} mutating routes are refused to ` +
          `AI-initiated requests.`
        : `NOT COMPLIANT: ${gaps.length} mutating route(s) appear to touch a resource docs/06 ` +
          `§6 forbids AI from changing, and the autonomy policy does not cover them. ` +
          `AI-initiated requests to those routes are not refused.`,
      method:
        'Computed by walking the Nest router at request time. Every registered handler is ' +
        'classified from its own @Audited(...) metadata, its @RequirePermissions(...) and its ' +
        'HTTP verb — no path list is maintained by hand.',
      summary: {
        totalRoutes: all.length,
        mutatingRoutes: mutating.length,
        coveredRoutes: covered,
        gapCount: gaps.length,
        mutatingRoutesWithoutAuditMetadata: unaudited.length,
      },
      coverage: FORBIDDEN_AUTONOMOUS_ACTIONS.map((action) => ({
        key: action.key,
        clause: action.clause,
        routeCount: mutating.filter((route) =>
          matchingActions(route).some((match) => match.key === action.key),
        ).length,
      })),
      gaps,
      mutatingRoutesWithoutAuditMetadata: unaudited.map(publish),
    };
  }

  /**
   * The AI-initiated audit trail.
   *
   * `runInTenant`, so a reader sees their own tenant's trail and nothing else — the audit
   * write path is privileged, the read path is not (the same split `AuditService` makes).
   *
   * The projection is deliberate rather than `select()`: this endpoint answers "how was this
   * decided", and IP address and user agent answer a different question that `/audit-logs`
   * already serves to the same permission. A narrower default is the right one for a document
   * that gets exported and emailed.
   */
  async aiActions(query: AiActionQuery, page: OffsetPageRequest): Promise<OffsetPage<AiActionRow>> {
    return this.db.runInTenant(async (tx) => {
      const filters: SQL[] = [eq(auditLogs.isAiInitiated, true)];
      if (query.module) filters.push(eq(auditLogs.module, query.module));
      if (query.resourceType) filters.push(eq(auditLogs.resourceType, query.resourceType));
      if (query.resourceId) filters.push(eq(auditLogs.resourceId, query.resourceId));
      if (query.actorUserId) filters.push(eq(auditLogs.actorUserId, query.actorUserId));
      if (query.action) filters.push(eq(auditLogs.action, query.action));
      if (query.institutionId) filters.push(eq(auditLogs.institutionId, query.institutionId));
      if (query.from) filters.push(gte(auditLogs.occurredAt, query.from));
      if (query.to) filters.push(lte(auditLogs.occurredAt, query.to));

      const where = and(...filters);

      const rows = await tx
        .select({
          id: auditLogs.id,
          occurredAt: auditLogs.occurredAt,
          actorUserId: auditLogs.actorUserId,
          actorRoles: auditLogs.actorRoles,
          action: auditLogs.action,
          module: auditLogs.module,
          resourceType: auditLogs.resourceType,
          resourceId: auditLogs.resourceId,
          resourceLabel: auditLogs.resourceLabel,
          previousValue: auditLogs.previousValue,
          newValue: auditLogs.newValue,
          reason: auditLogs.reason,
          requestId: auditLogs.requestId,
          institutionId: auditLogs.institutionId,
          isAiInitiated: auditLogs.isAiInitiated,
        })
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
        .limit(page.pageSize)
        .offset(offsetOf(page));

      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(where);

      return buildOffsetPage(rows as AiActionRow[], counted?.total ?? 0, page);
    });
  }
}

function publish(route: RouteDescriptor): PublishedRoute {
  return {
    method: route.method,
    path: route.path,
    controller: route.controller,
    handler: route.handler,
    permissions: route.permissions,
    audit: route.audit,
  };
}
