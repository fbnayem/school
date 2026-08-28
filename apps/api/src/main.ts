/**
 * API bootstrap.
 *
 * The order of concerns here is deliberate: configuration is validated before anything is
 * constructed, security headers are applied before any route exists, and the route audit runs
 * before the server starts listening — so a misconfigured or unprotected build fails at boot
 * rather than serving traffic.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { corsOrigins, loadEnv } from './config/env';
import { getLogger, initLogger } from './common/logger';
import { assertRoutesProtected } from './common/route-audit';

async function bootstrap(): Promise<void> {
  // Validated first. A missing JWT_SECRET should fail here, loudly, not at the first login.
  const config = loadEnv();
  const logger = initLogger({
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
    environment: config.NODE_ENV,
  });

  const app = await NestFactory.create(AppModule, {
    // Nest's own logger is replaced by pino so boot messages carry the same structure and
    // redaction as request logs.
    logger: ['error', 'warn', 'log'],
    bufferLogs: false,
  });

  app.setGlobalPrefix(config.API_PREFIX);

  /**
   * Trust exactly one proxy hop.
   *
   * `trust proxy: true` would let any client forge `x-forwarded-for` and thereby forge the IP
   * that rate limiting and brute-force detection key on. A specific hop count matches the real
   * deployment (one load balancer) and makes spoofing ineffective.
   */
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.use(
    helmet({
      // The API returns JSON, not HTML, so a restrictive CSP costs nothing and blocks the
      // browser from executing anything if a response is ever mistakenly rendered.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      // Two years, subdomains included. Only meaningful over HTTPS, hence the guard.
      hsts: config.COOKIE_SECURE
        ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
        : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(cookieParser());

  app.enableCors({
    origin: corsOrigins(config.CORS_ORIGINS),
    // Required for the httpOnly cookie flow. It is also why the origin list must be explicit:
    // credentials plus a wildcard origin is rejected by browsers, and rightly so.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-request-id',
      'x-institution-id',
      'x-campus-id',
    ],
    exposedHeaders: ['x-request-id'],
    maxAge: 86_400,
  });

  // Bounded body size. The default is 100kb; imports and uploads use multipart routes with
  // their own limits rather than raising this for every endpoint.
  const express = app.getHttpAdapter().getInstance() as {
    set: (key: string, value: unknown) => void;
  };
  express.set('x-powered-by', false);

  if (config.ENABLE_SWAGGER && config.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('ShikkhaOS API')
        .setDescription(
          'Multi-tenant School Operating System. Every endpoint is tenant-scoped and ' +
            'permission-checked; see docs/05_RBAC_PERMISSION_MATRIX.md.',
        )
        .setVersion('0.1.0')
        .addBearerAuth()
        .addGlobalParameters({
          name: 'x-institution-id',
          in: 'header',
          required: false,
          description: 'Institution to act within. Required by institution-scoped endpoints.',
          schema: { type: 'string', format: 'uuid' },
        })
        .build(),
    );
    SwaggerModule.setup(`${config.API_PREFIX}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    logger.info(`API documentation at /${config.API_PREFIX}/docs`);
  }

  // Refuses to start if any route declares neither @Public() nor @RequirePermissions(...).
  assertRoutesProtected(app, (message) => logger.info(message));

  app.enableShutdownHooks();

  await app.listen(config.PORT, '0.0.0.0');
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, prefix: config.API_PREFIX },
    'ShikkhaOS API is listening',
  );
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet if configuration failed, so this writes to stderr directly.
  const message = error instanceof Error ? error.message : String(error);

  console.error(`\nFailed to start the API:\n${message}\n`);
  if (error instanceof Error && error.stack) {
    getLogger().error({ err: error }, 'bootstrap failed');
  }
  process.exit(1);
});
