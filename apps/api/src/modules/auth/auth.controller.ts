/**
 * Authentication endpoints.
 *
 * Tokens are delivered two ways at once, and which one a client uses is its own choice:
 *
 *  - **httpOnly cookies** for the browser. JavaScript cannot read them, so an XSS bug cannot
 *    exfiltrate the session. `SameSite=Lax` blocks cross-site form posts while still allowing
 *    top-level navigation back from a payment gateway.
 *  - **The response body** for Flutter and server-to-server callers, which have no cookie jar
 *    and store tokens in the platform keychain.
 *
 * The refresh cookie is path-scoped to the refresh endpoint, so it is not attached to the
 * hundreds of ordinary API requests that have no use for it.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  resetPasswordSchema,
  type LoginInput as LoginBody,
} from '@shikkha/validation';
import { z } from 'zod';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, UnauthenticatedError } from '@shikkha/shared';
import { ALL_PERMISSIONS, effectivePermissions, type Principal } from '@shikkha/permissions';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { PrincipalService } from './principal.service';
import { Authenticated, CurrentUser, Public } from '../../common/decorators';
import { AuthRateLimit } from '../../common/guards/rate-limit.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { env } from '../../config/env';
import { currentContext } from '../../common/context/request-context';

const REFRESH_COOKIE_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly principals: PrincipalService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Far tighter than the global limit, and resolved from AUTH_RATE_LIMIT_MAX_ATTEMPTS at
  // request time so it can be tuned without a deploy.
  @AuthRateLimit()
  @ApiOperation({ summary: 'Sign in with an email address or phone number' })
  async login(
    @Body(zodBody(loginSchema)) body: LoginBody,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(body);

    // Accounts with TOTP enabled get a short-lived challenge instead of a session. No
    // cookies are set: nothing has been fully authenticated yet.
    if ('mfaRequired' in result) {
      return {
        mfaRequired: true,
        challengeToken: result.challengeToken,
        expiresIn: result.expiresInSeconds,
      };
    }

    setAuthCookies(response, result.accessToken, result.refreshToken, result.refreshTokenExpiresAt);
    return {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.accessTokenExpiresIn,
    };
  }

  /**
   * Anti-enumeration contract: the response — body, status, and the Argon2-shaped work
   * behind it — is identical whether or not the identifier matches an account. See
   * `PasswordResetService.request`.
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @AuthRateLimit()
  @ApiOperation({ summary: 'Request a password reset by email or phone number' })
  async forgotPassword(
    @Body(zodBody(forgotPasswordSchema)) body: z.infer<typeof forgotPasswordSchema>,
  ) {
    return this.passwordReset.request(body.identifier);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AuthRateLimit()
  @ApiOperation({ summary: 'Set a new password using a reset link' })
  async resetPassword(
    @Body(zodBody(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
  ): Promise<void> {
    await this.passwordReset.reset(body.token, body.newPassword);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @AuthRateLimit()
  @ApiOperation({ summary: 'Exchange a refresh token for a new access token' })
  async refresh(
    @Body(zodBody(refreshSchema)) body: { refreshToken?: string; deviceLabel?: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
    const token = body.refreshToken ?? cookies?.[REFRESH_TOKEN_COOKIE];
    if (!token) {
      throw new UnauthenticatedError('No refresh token was provided');
    }

    const result = await this.auth.refresh(token, body.deviceLabel);
    setAuthCookies(response, result.accessToken, result.refreshToken, result.refreshTokenExpiresAt);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.accessTokenExpiresIn,
    };
  }

  /**
   * Ending your own session is not a permission anyone could be denied, so these routes
   * declare `@Authenticated()` rather than borrowing an unrelated permission.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @ApiOperation({ summary: 'End the current session' })
  async logout(
    @CurrentUser() principal: Principal,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
    await this.auth.logout(cookies?.[REFRESH_TOKEN_COOKIE] ?? null, principal.userId);
    clearAuthCookies(response);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @ApiOperation({ summary: 'End every session for this account on all devices' })
  async logoutAll(
    @CurrentUser() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ) {
    const revoked = await this.auth.logoutAll(principal.userId);
    clearAuthCookies(response);
    return { revokedSessions: revoked };
  }

  /**
   * The bootstrap call every client makes on load: who am I, and what may I do?
   *
   * Returning the flattened permission list lets the UI hide unavailable actions. It is a
   * rendering convenience only — the server re-checks every request, so a client that edits
   * this list gains nothing but a button that returns 403.
   */
  @Get('me')
  @Authenticated()
  @ApiOperation({ summary: 'The current user, their scope, and their effective permissions' })
  async me(@CurrentUser() principal: Principal) {
    const loaded = await this.principals.loadPrincipal(principal.userId);
    if (!loaded) throw new UnauthenticatedError();

    const context = currentContext();
    return {
      user: {
        id: loaded.principal.userId,
        email: loaded.email,
        fullNameEn: loaded.fullNameEn,
        locale: loaded.locale,
        tenantId: loaded.principal.tenantId,
        isPlatformAdmin: loaded.principal.isPlatformAdmin,
        mustChangePassword: loaded.mustChangePassword,
        employeeId: loaded.principal.employeeId ?? null,
        guardianId: loaded.principal.guardianId ?? null,
        studentId: loaded.principal.studentId ?? null,
      },
      roles: loaded.principal.roles.map((role) => ({
        key: role.roleKey,
        institutionIds: role.institutionIds,
        campusIds: role.campusIds,
      })),
      permissions: effectivePermissions(loaded.principal, ALL_PERMISSIONS, {
        institutionId: context?.institutionId ?? null,
        campusId: context?.campusId ?? null,
      }),
    };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @AuthRateLimit()
  @ApiOperation({ summary: 'Change your own password' })
  async changePassword(
    @CurrentUser() principal: Principal,
    @Body(zodBody(changePasswordSchema))
    body: { currentPassword: string; newPassword: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.changePassword(principal.userId, body.currentPassword, body.newPassword);
    // Every session was revoked, including this one; clearing the cookies avoids the client
    // sitting on tokens that will start failing on the next request.
    clearAuthCookies(response);
  }
}

function setAuthCookies(
  response: Response,
  accessToken: string,
  refreshToken: string,
  refreshExpiresAt: Date,
): void {
  const config = env();
  const common = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    // Lax rather than Strict: a payment gateway returning the user to the app via a top-level
    // redirect must not land them logged out. Lax still blocks cross-site POSTs, which is the
    // CSRF vector that matters.
    sameSite: 'lax' as const,
    domain: config.COOKIE_DOMAIN,
  };

  response.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
    ...common,
    path: '/',
    maxAge: config.ACCESS_TOKEN_TTL_SECONDS * 1000,
  });

  response.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    ...common,
    // Scoped so the long-lived credential is not attached to every ordinary API request.
    path: REFRESH_COOKIE_PATH,
    expires: refreshExpiresAt,
  });
}

function clearAuthCookies(response: Response): void {
  const config = env();
  const common = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax' as const,
    domain: config.COOKIE_DOMAIN,
  };
  response.clearCookie(ACCESS_TOKEN_COOKIE, { ...common, path: '/' });
  response.clearCookie(REFRESH_TOKEN_COOKIE, { ...common, path: REFRESH_COOKIE_PATH });
}
