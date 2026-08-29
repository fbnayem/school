import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { PasswordResetService } from './password-reset.service';
import { PasswordService } from './password.service';
import { PrincipalService } from './principal.service';
import { TokenService } from './token.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Global because the guards — which are themselves global — depend on TokenService and
 * PrincipalService. Scoping this module would mean re-importing it into every feature module
 * purely to satisfy the guard chain.
 *
 * The auth lifecycle services (invitations, password reset, MFA) live here rather than in a
 * separate module because they share the whole credential machinery — Argon2 hashing, the
 * SHA-256 token hash, session issuance, the security event log — and splitting them would
 * turn that sharing into circular imports.
 */
@Global()
@Module({
  imports: [JwtModule.register({}), NotificationsModule],
  controllers: [AuthController, InvitationsController, MfaController],
  providers: [
    AuthService,
    PasswordService,
    PrincipalService,
    TokenService,
    InvitationsService,
    PasswordResetService,
    MfaService,
  ],
  exports: [
    AuthService,
    PasswordService,
    PrincipalService,
    TokenService,
    InvitationsService,
    PasswordResetService,
    MfaService,
  ],
})
export class AuthModule {}
