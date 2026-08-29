/**
 * TOTP multi-factor endpoints.
 *
 * Everything except `verify` is self-service on the signed-in account, so `@Authenticated()`
 * is the right access declaration — MFA on your own account is not a permission anyone
 * could sensibly be denied. `verify` is public because it happens mid-login, before a
 * session exists; the short-lived challenge token is the credential it consumes.
 *
 * Every route carries the strict credential-endpoint rate limit: each one either handles a
 * password, a shared-secret code, or a challenge token.
 */

import { Body, Controller, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '@shikkha/shared';
import type { Principal } from '@shikkha/permissions';
import {
  mfaDisableSchema,
  mfaEnableSchema,
  mfaRegenerateRecoveryCodesSchema,
  mfaVerifySchema,
} from '@shikkha/validation';
import { MfaService } from './mfa.service';
import { Authenticated, CurrentUser, Public } from '../../common/decorators';
import { AuthRateLimit } from '../../common/guards/rate-limit.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { env } from '../../config/env';

const REFRESH_COOKIE_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller('auth/mfa')
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @AuthRateLimit()
  @ApiOperation({
    summary: 'Begin TOTP enrolment: returns the shared secret and otpauth URI, exactly once',
  })
  async enroll(@CurrentUser() principal: Principal) {
    return this.mfa.enroll(principal);
  }

  /**
   * No `@Audited` on the MFA mutations: like `change-password`, the service writes its own
   * audit record. The interceptor's fallback would copy the request body into the audit
   * log, and a body here carries a live TOTP code or password.
   */
  @Post('enable')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @AuthRateLimit()
  @ApiOperation({
    summary: 'Verify a code from the authenticator and switch MFA on; returns recovery codes',
  })
  async enable(
    @CurrentUser() principal: Principal,
    @Body(zodBody(mfaEnableSchema)) body: z.infer<typeof mfaEnableSchema>,
  ) {
    return this.mfa.enable(principal, body.code);
  }

  /**
   * The second login step. Public by necessity — no session exists yet — and the response
   * mirrors `POST /auth/login`: tokens in the body for mobile clients, httpOnly cookies
   * for the browser.
   */
  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @AuthRateLimit()
  @ApiOperation({ summary: 'Complete sign-in with a TOTP code or recovery code' })
  async verify(
    @Body(zodBody(mfaVerifySchema)) body: z.infer<typeof mfaVerifySchema>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.mfa.verifyChallenge(body.challengeToken, body.code, body.deviceLabel);
    setAuthCookies(response, result.accessToken, result.refreshToken, result.refreshTokenExpiresAt);
    return {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.accessTokenExpiresIn,
    };
  }

  @Post('disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @AuthRateLimit()
  @ApiOperation({ summary: 'Disable MFA. Requires the current password.' })
  async disable(
    @CurrentUser() principal: Principal,
    @Body(zodBody(mfaDisableSchema)) body: z.infer<typeof mfaDisableSchema>,
  ): Promise<void> {
    await this.mfa.disable(principal, body.password);
  }

  @Post('recovery-codes')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @AuthRateLimit()
  @ApiOperation({ summary: 'Regenerate recovery codes. Requires the current password.' })
  async regenerate(
    @CurrentUser() principal: Principal,
    @Body(zodBody(mfaRegenerateRecoveryCodesSchema))
    body: z.infer<typeof mfaRegenerateRecoveryCodesSchema>,
  ) {
    return this.mfa.regenerateRecoveryCodes(principal, body.password);
  }
}

/** Identical cookie semantics to the login endpoint, for the same reasons. */
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
    path: REFRESH_COOKIE_PATH,
    expires: refreshExpiresAt,
  });
}
