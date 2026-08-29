/**
 * The router, read back as data.
 *
 * The attestation endpoint has to answer "every route in the application that mutates one of
 * these resources, and whether the policy covers it". The only honest source for "every route
 * in the application" is the router itself. A hand-maintained list would be accurate on the
 * day it was written and would then quietly stop being the answer, which is the exact failure
 * the attestation exists to prevent.
 *
 * So this walks Nest's own module container — the same walk `common/route-audit.ts` does at
 * boot to refuse to start on an unprotected route — and reduces each handler to a
 * `RouteDescriptor`. Two differences from that file, both deliberate:
 *
 *  - it keeps the `@Audited(...)` metadata rather than only asking whether it is present,
 *    because module and resource type are what the policy matches on;
 *  - it is a service rather than a function taking an `INestApplication`, because it has to be
 *    callable from a request handler and `ModulesContainer` is injectable.
 *
 * The inventory is built **once**, lazily, and cached. The router does not change after boot,
 * and rebuilding it per request would make a governance read the most expensive endpoint in
 * the API.
 *
 * Paths are reported without the global prefix (`api/v1`), matching `route-audit.ts`. The
 * prefix is a deployment concern; the policy is about which handler, not which URL.
 */

import { Injectable } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { AUDIT_KEY, PERMISSIONS_KEY, PUBLIC_KEY, type AuditMetadata } from '../../common/decorators';
import type { RouteDescriptor } from './ai-autonomy.policy';

@Injectable()
export class RouteInventoryService {
  private cached: RouteDescriptor[] | null = null;

  constructor(
    private readonly modules: ModulesContainer,
    private readonly reflector: Reflector,
  ) {}

  /** Every registered HTTP handler, sorted so two runs produce the same document. */
  all(): readonly RouteDescriptor[] {
    if (this.cached) return this.cached;

    const routes: RouteDescriptor[] = [];

    for (const module of this.modules.values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
        if (!controller?.prototype) continue;

        const basePath = (Reflect.getMetadata(PATH_METADATA, controller) as string) ?? '';

        for (const property of Object.getOwnPropertyNames(controller.prototype)) {
          if (property === 'constructor') continue;
          const handler = (controller.prototype as Record<string, unknown>)[property];
          if (typeof handler !== 'function') continue;

          const method = Reflect.getMetadata(METHOD_METADATA, handler) as
            | RequestMethod
            | undefined;
          if (method === undefined) continue; // Not a route handler.

          // `@Public()` routes are login, health, and the public admission form. They carry no
          // principal and cannot be reached by the gateway, which always calls with a
          // caller's bearer token — but they are still listed, because a public *mutating*
          // route that touched a forbidden resource is something the attestation must show.
          const isPublic =
            this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, controller]) ?? false;

          const permissions =
            this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [handler, controller]) ??
            [];
          const audit =
            this.reflector.getAllAndOverride<AuditMetadata>(AUDIT_KEY, [handler, controller]) ??
            null;

          const methodPath = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? '';

          routes.push({
            controller: controller.name,
            handler: property,
            method: RequestMethod[method] ?? String(method),
            path: joinPath(basePath, methodPath),
            permissions: isPublic ? [] : permissions,
            audit: audit
              ? { module: audit.module, resourceType: audit.resourceType, action: audit.action }
              : null,
          });
        }
      }
    }

    routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    this.cached = routes;
    return routes;
  }
}

/**
 * `/exams/:id/publish` from `exams` and `:id/publish`.
 *
 * Nest stores `/` for a bare `@Get()`, so the naive join produces `//` and `/exams//`, and a
 * reader comparing the attestation against their browser's address bar would be looking at
 * two different strings for the same route.
 */
function joinPath(basePath: string, methodPath: string): string {
  return `/${[basePath, methodPath].join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
}
