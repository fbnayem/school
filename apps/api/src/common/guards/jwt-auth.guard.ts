/**
 * Authentication guard.
 *
 * Validates the access token, loads the principal, and attaches it to the request and the
 * async context. Applied globally: a route is authenticated unless it carries `@Public()`.
 *
 * Two checks here are easy to omit and expensive to omit:
 *
 *  1. **`credentialsChangedAt`.** A JWT is valid until it expires, which means a password
 *     change, a role revocation or a "log out everywhere" would otherwise leave existing
 *     tokens working for up to 15 minutes. Comparing the user's `credentials_changed_at`
 *     against the token's millisecond-precision `cav` claim closes that window exactly.
 *  2. **Account status.** A suspended or deactivated user holding a live token must be
 *     refused, not merely prevented from getting a new one.
 *
 * Both require a database read per request. That is the price of revocable sessions, and it is
 * a single indexed primary-key lookup.
 */

import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ACCESS_TOKEN_COOKIE } from '@shikkha/shared';
import { PUBLIC_KEY } from '../decorators';
import { attachPrincipal } from '../context/request-context';
import { TokenService, type AccessTokenClaims } from '../../modules/auth/token.service';
import { PrincipalService } from '../../modules/auth/principal.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly principals: PrincipalService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { principal?: unknown }>();
    const token = extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Authentication is required');
    }

    let claims: AccessTokenClaims;
    try {
      claims = await this.tokens.verifyAccessToken(token);
    } catch {
      // The specific reason (expired, malformed, wrong signature) is logged, not returned.
      throw new UnauthorizedException('Your session is not valid. Please sign in again.');
    }

    const principal = await this.principals.loadPrincipal(claims.sub);
    if (!principal) {
      throw new UnauthorizedException('Your session is not valid. Please sign in again.');
    }

    // Exact, with no tolerance: `cav` is a millisecond timestamp captured at issue time, so a
    // password change or a "log out everywhere" invalidates every outstanding token
    // immediately rather than within a second (see AccessTokenClaims).
    if (principal.credentialsChangedAt.getTime() > claims.cav) {
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }

    if (principal.status !== 'active') {
      throw new UnauthorizedException('This account is not active.');
    }

    (request as Request & { principal?: unknown }).principal = principal.principal;
    attachPrincipal(principal.principal);
    return true;
  }
}

/**
 * Accept the token from an httpOnly cookie (browser) or an Authorization header (mobile,
 * server-to-server). Cookie first: if both are present, the browser's own cookie is the more
 * trustworthy of the two, and preferring the header would let a reflected header override it.
 */
function extractToken(request: Request): string | null {
  const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
  const fromCookie = cookies?.[ACCESS_TOKEN_COOKIE];
  if (fromCookie) return fromCookie;

  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;

  return null;
}
