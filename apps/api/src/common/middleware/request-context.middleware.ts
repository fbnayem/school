/**
 * Establishes the request context.
 *
 * Implemented as middleware rather than an interceptor because middleware runs **before
 * guards**, and the guards are exactly the code that needs to write into the context (the
 * principal, the institution scope) and log against the request id. An interceptor would run
 * too late.
 */

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { uuidv7 } from '@shikkha/shared';
import { runWithRequestContext, type RequestContext } from '../context/request-context';
import { getLogger } from '../logger';

/** Bound so a client cannot inflate log lines with a megabyte "request id". */
const MAX_INBOUND_REQUEST_ID = 64;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]+$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const context: RequestContext = {
      requestId: resolveRequestId(request),
      principal: null,
      tenantId: null,
      institutionId: null,
      campusId: null,
      ipAddress: resolveClientIp(request),
      userAgent: truncate(request.headers['user-agent'], 512),
      method: request.method,
      path: request.originalUrl.split('?')[0] ?? request.originalUrl,
      startedAt: Date.now(),
    };

    // Echoed on every response, including errors, so a user can quote it in a support ticket.
    response.setHeader('x-request-id', context.requestId);
    (request as Request & { context: RequestContext }).context = context;

    runWithRequestContext(context, () => {
      response.on('finish', () => {
        const durationMs = Date.now() - context.startedAt;
        const logger = getLogger();
        // Health checks would otherwise dominate the log at one line every few seconds.
        const level = context.path.includes('/health') ? 'debug' : 'info';
        logger[level](
          {
            method: context.method,
            path: context.path,
            status: response.statusCode,
            durationMs,
          },
          'request completed',
        );
      });
      next();
    });
  }
}

/**
 * Accept an inbound request id so a trace spans the web app and the API, but only if it looks
 * like an identifier. An unvalidated header ends up in logs and in the audit table, which is
 * both a log-injection vector and a way to poison a search index.
 */
function resolveRequestId(request: Request): string {
  const inbound = request.headers['x-request-id'];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  if (
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= MAX_INBOUND_REQUEST_ID &&
    SAFE_REQUEST_ID.test(candidate)
  ) {
    return candidate;
  }
  return uuidv7();
}

/**
 * The client IP.
 *
 * `x-forwarded-for` is trusted only because `app.set('trust proxy', ...)` is configured to
 * match the deployment's actual proxy depth — Express then populates `request.ip` correctly.
 * Reading the raw header directly would let any client forge its own address, which would
 * corrupt the brute-force counters that key on it.
 */
function resolveClientIp(request: Request): string | null {
  const ip = request.ip ?? request.socket.remoteAddress ?? null;
  if (!ip) return null;
  // Normalise IPv4-mapped IPv6 so rate-limit buckets and audit rows agree on one form.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function truncate(value: string | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}
