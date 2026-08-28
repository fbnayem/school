import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { PrincipalService } from './principal.service';
import { TokenService } from './token.service';

/**
 * Global because the guards — which are themselves global — depend on TokenService and
 * PrincipalService. Scoping this module would mean re-importing it into every feature module
 * purely to satisfy the guard chain.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, PrincipalService, TokenService],
  exports: [AuthService, PasswordService, PrincipalService, TokenService],
})
export class AuthModule {}
