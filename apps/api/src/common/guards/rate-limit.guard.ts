/**
 * Rate limiting.
 *
 * This exists as a custom guard rather than a bare `ThrottlerGuard` because of two problems
 * with the obvious configuration, both of which were live defects before this file:
 *
 *  1. **Every named throttler applies to every route.** Registering a strict `auth` throttler
 *     alongside a permissive `default` one does not scope the strict limit to auth routes — it
 *     applies *both* to all routes, so the whole API inherits the login limit. The symptom is
 *     a teacher hitting 429 after ten page loads.
 *  2. **`@Throttle({ limit: 10 })` hardcodes the number at class-definition time**, so the
 *     documented `AUTH_RATE_LIMIT_MAX_ATTEMPTS` environment variable had no effect. Limits
 *     that operations cannot tune without a deploy get turned off instead of tuned.
 *
 * So: one throttler, and routes marked `@AuthRateLimit()` get a stricter limit resolved from
 * configuration on each request.
 */

import { type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerRequest,
} from '@nestjs/throttler';
import type { Request } from 'express';
import { env } from '../../config/env';
import { getLogger } from '../logger';

export const AUTH_RATE_LIMIT_KEY = 'shikkha:auth-rate-limit';

/**
 * Apply the stricter credential-endpoint limit.
 *
 * Login, refresh, password reset and invitation acceptance. Credential stuffing is a volume
 * attack, and the per-account lockout alone does not stop one password sprayed across many
 * accounts — that only shows up as volume from one source.
 */
export const AuthRateLimit = () => SetMetadata(AUTH_RATE_LIMIT_KEY, true);

@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  /**
   * Track by client IP.
   *
   * `request.ip` is populated by Express from `x-forwarded-for` only because `trust proxy` is
   * set to the real proxy depth in `main.ts`. Reading the header directly would let any client
   * forge its own address and bypass the limit entirely.
   */
  protected override async getTracker(req: Request): Promise<string> {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }

  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const config = env();
    const context = requestProps.context;

    const isAuthRoute = this.reflector.getAllAndOverride<boolean>(AUTH_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Limits resolved per request, so an operator can change them without a deploy.
    const limit = isAuthRoute
      ? config.AUTH_RATE_LIMIT_MAX_ATTEMPTS
      : config.RATE_LIMIT_MAX_REQUESTS;
    const ttl = (isAuthRoute ? 60 : config.RATE_LIMIT_WINDOW_SECONDS) * 1000;

    return super.handleRequest({ ...requestProps, limit, ttl });
  }

  /**
   * Record the refusal before throwing.
   *
   * A burst of 429s from one address is the signal that separates a misbehaving client from an
   * attack, and it is only visible if it is written down.
   *
   * Logged rather than written to `security_events`: `ThrottlerGuard`'s constructor signature
   * is fixed by the framework, so injecting the audit service here would mean re-declaring its
   * three internal dependencies by token and re-checking them on every upgrade. The structured
   * log carries the same fields and is what an aggregator alerts on anyway.
   */
  protected override async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const request = context.switchToHttp().getRequest<Request>();
    getLogger().warn(
      {
        method: request.method,
        path: request.originalUrl,
        limit: throttlerLimitDetail.limit,
        ttl: throttlerLimitDetail.ttl,
        tracker: throttlerLimitDetail.key,
      },
      'rate limit exceeded',
    );
    return super.throwThrottlingException(context, throttlerLimitDetail);
  }
}
