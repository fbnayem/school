/**
 * Application composition.
 *
 * The guard order below is the security model of the whole product, and it is order-sensitive:
 *
 *   RateLimitGuard  — refuse abusive volume before doing any work
 *   JwtAuthGuard    — who is this?
 *   TenantGuard     — which tenant and institution are they acting in?
 *   PermissionsGuard— may they do this, here?
 *
 * Nest applies `APP_GUARD` providers in registration order, so this array is the chain.
 * Authorization cannot run before authentication, and tenant resolution cannot run before
 * either — getting this wrong produces a system that authorises against an unresolved scope.
 */

import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { env } from './config/env';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { TenantGuard } from './common/guards/tenant.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { SerializationInterceptor } from './common/interceptors/serialization.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { DatabaseModule } from './modules/database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuditModule } from './modules/audit/audit.module';
import { HealthModule } from './modules/health/health.module';
import { StorageModule } from './modules/storage/storage.module';
import { StudentsModule } from './modules/students/students.module';
import { AcademicModule } from './modules/academic/academic.module';
import { GuardiansModule } from './modules/guardians/guardians.module';

@Module({
  imports: [
    /**
     * One throttler, not two.
     *
     * Every named throttler applies to every route, so a second strict "auth" throttler would
     * silently impose the login limit on the whole API. The stricter credential limit is
     * applied instead by `RateLimitGuard`, which resolves it per request from configuration
     * for routes marked `@AuthRateLimit()`.
     *
     * Storage is in-memory, which means the limit is per instance. Behind more than one
     * replica that multiplies the effective limit by the replica count — see
     * docs/11_DEPLOYMENT.md for the Redis-backed storage that fixes it.
     */
    ThrottlerModule.forRootAsync({
      useFactory: () => {
        const config = env();
        return {
          throttlers: [
            {
              name: 'default',
              ttl: config.RATE_LIMIT_WINDOW_SECONDS * 1000,
              limit: config.RATE_LIMIT_MAX_REQUESTS,
            },
          ],
        };
      },
    }),
    DatabaseModule,
    AuthModule,
    AuditModule,
    HealthModule,
    StorageModule,
    AcademicModule,
    StudentsModule,
    GuardiansModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Interceptors run in registration order on the way in, reverse on the way out — so
    // serialisation strips `__audit` only after the audit interceptor has read it.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: SerializationInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route including health, so even a failed health check has a request id.
    // `{*path}` rather than `*`: Express 5 / path-to-regexp 8 require a named wildcard.
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}
