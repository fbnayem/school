/**
 * Boot-time route audit.
 *
 * Walks every registered HTTP handler and refuses to start unless each one declares its
 * access requirement: `@Public()`, `@Authenticated()`, or `@RequirePermissions(...)`.
 *
 * This exists because the most common way an authorization hole ships is not a wrong check —
 * it is a missing one. A new controller method with no decorator would otherwise inherit
 * "authenticated but unrestricted", which reads as safe and is not. Making it a startup crash
 * means the hole cannot reach code review, let alone production.
 *
 * It also flags mutating routes that carry no `@Audited(...)`, as a warning rather than a
 * failure: not every POST is audit-worthy, but a POST that nobody thought about usually is.
 */

import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { AUDIT_KEY, AUTHENTICATED_KEY, PERMISSIONS_KEY, PUBLIC_KEY } from './decorators';

export interface RouteAuditResult {
  total: number;
  publicRoutes: string[];
  /** Routes open to any authenticated user — self-service only. */
  selfServiceRoutes: string[];
  unprotected: string[];
  unaudited: string[];
}

const MUTATING_METHODS = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

export function auditRoutes(app: INestApplication): RouteAuditResult {
  const reflector = app.get(Reflector);
  const container = (
    app as unknown as {
      container: {
        getModules: () => Map<string, { controllers: Map<unknown, { metatype: unknown }> }>;
      };
    }
  ).container;

  const publicRoutes: string[] = [];
  const selfServiceRoutes: string[] = [];
  const unprotected: string[] = [];
  const unaudited: string[] = [];
  let total = 0;

  for (const module of container.getModules().values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      if (!controller?.prototype) continue;

      const basePath = (Reflect.getMetadata(PATH_METADATA, controller) as string) ?? '';

      for (const property of Object.getOwnPropertyNames(controller.prototype)) {
        if (property === 'constructor') continue;
        const handler = controller.prototype[property] as unknown;
        if (typeof handler !== 'function') continue;

        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue; // Not a route handler.

        total += 1;
        const path = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? '';
        const label = `${RequestMethod[method]} /${basePath}/${path}`.replace(/\/+/g, '/');

        const isPublic = reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, controller]);
        const isAuthenticatedOnly = reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, [
          handler,
          controller,
        ]);
        const permissions = reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
          handler,
          controller,
        ]);
        const audited = reflector.getAllAndOverride<unknown>(AUDIT_KEY, [handler, controller]);

        if (isPublic) {
          publicRoutes.push(label);
          continue;
        }
        if (isAuthenticatedOnly) {
          selfServiceRoutes.push(label);
          continue;
        }
        if (!permissions || permissions.length === 0) {
          unprotected.push(label);
          continue;
        }
        if (MUTATING_METHODS.has(method) && !audited) {
          unaudited.push(label);
        }
      }
    }
  }

  return { total, publicRoutes, selfServiceRoutes, unprotected, unaudited };
}

export function assertRoutesProtected(app: INestApplication, log: (message: string) => void): void {
  const result = auditRoutes(app);

  if (result.unprotected.length > 0) {
    throw new Error(
      `Refusing to start: ${result.unprotected.length} route(s) declare neither @Public() nor ` +
        `@RequirePermissions(...).\n` +
        result.unprotected.map((route) => `  ${route}`).join('\n') +
        `\n\nEvery route must state its access requirement explicitly.`,
    );
  }

  log(
    `Route audit: ${result.total} routes, ${result.publicRoutes.length} public, ` +
      `${result.selfServiceRoutes.length} self-service, ` +
      `${result.unaudited.length} mutating routes without an audit record.`,
  );

  if (result.publicRoutes.length > 0) {
    // Printed at every boot on purpose: the public surface is the attack surface, and it
    // should be small enough to read in the logs.
    log(`Public routes:\n${result.publicRoutes.map((route) => `  ${route}`).join('\n')}`);
  }
  if (result.unaudited.length > 0) {
    log(
      `Mutating routes with no @Audited(...):\n` +
        result.unaudited.map((route) => `  ${route}`).join('\n'),
    );
  }
}
