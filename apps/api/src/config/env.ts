/**
 * Environment configuration.
 *
 * Parsed once at boot with Zod and then frozen. A missing or malformed variable is a
 * startup failure with a readable message, not a `undefined` that surfaces three hours later
 * as a confusing runtime error in production.
 *
 * The `superRefine` block at the bottom is the part worth reading: it refuses to start with
 * development defaults when `NODE_ENV=production`. Shipping with `JWT_SECRET=dev-secret` is a
 * complete authentication bypass, and the only reliable defence is to make the process refuse
 * to run.
 */

import { z } from 'zod';

const DEV_PLACEHOLDER_SECRETS = new Set([
  'dev-secret',
  'change-me',
  'changeme',
  'secret',
  'shikkha_dev_password',
  'development-only-secret-not-for-production',
]);

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const port = z.coerce.number().int().min(1).max(65_535);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(4000),
    /** Prefix applied to every route. Versioned so v2 can coexist. */
    API_PREFIX: z.string().default('api/v1'),
    /** Comma-separated list of allowed browser origins. Never `*` in production. */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    // `silent` is a real pino level and the only sane setting for a test run, where a few
    // hundred structured log lines per suite would bury the assertion output.
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: booleanish.default(false),

    /** The application connects as the unprivileged role that RLS applies to. */
    DATABASE_URL: z.string().url(),
    /** Owner role, used only by migrations and the seeder. */
    MIGRATION_DATABASE_URL: z.string().url().optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
    DATABASE_LOG_QUERIES: booleanish.default(false),

    REDIS_URL: z.string().url().default('redis://localhost:6380'),

    /** Signing key for access tokens. At least 32 bytes of entropy. */
    JWT_SECRET: z.string().min(32),
    JWT_ISSUER: z.string().default('shikkha-os'),
    JWT_AUDIENCE: z.string().default('shikkha-api'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3_600)
      .max(90 * 86_400)
      .default(30 * 86_400),

    /** Cookie domain. Leave unset for host-only cookies, which is correct for most setups. */
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: booleanish.default(false),
    /** Password reset and invitation links point here. */
    WEB_APP_URL: z.string().url().default('http://localhost:3000'),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./storage-local'),
    /** HMAC key for signing local storage URLs, so signed-URL semantics exist in dev too. */
    STORAGE_URL_SECRET: z.string().min(16).default('local-storage-signing-key-dev'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanish.default(true),

    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(300),
    /** Login is rate limited far more aggressively than ordinary reads. */
    AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
    /** Consecutive failures before an account is temporarily locked. */
    MAX_FAILED_LOGIN_ATTEMPTS: z.coerce.number().int().min(3).default(8),
    ACCOUNT_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),

    /** Argon2id parameters. Defaults follow the OWASP baseline. */
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(8_192).default(19_456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

    ENABLE_SWAGGER: booleanish.default(true),
    /** Serves seeded demo credentials on the login page. Development only. */
    ENABLE_DEMO_HINTS: booleanish.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    const reject = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if (DEV_PLACEHOLDER_SECRETS.has(env.JWT_SECRET)) {
      reject('JWT_SECRET', 'is a known development placeholder and must be replaced in production');
    }
    if (env.JWT_SECRET.length < 48) {
      reject('JWT_SECRET', 'must be at least 48 characters in production');
    }
    if (!env.COOKIE_SECURE) {
      reject('COOKIE_SECURE', 'must be true in production so session cookies require HTTPS');
    }
    if (env.CORS_ORIGINS.includes('*')) {
      reject('CORS_ORIGINS', 'must not contain a wildcard in production');
    }
    if (env.CORS_ORIGINS.includes('localhost')) {
      reject('CORS_ORIGINS', 'must not allow localhost in production');
    }
    if (env.STORAGE_DRIVER === 'local') {
      reject(
        'STORAGE_DRIVER',
        'must be "s3" in production; the local adapter is not durable and does not survive a redeploy',
      );
    }
    if (env.STORAGE_DRIVER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID)) {
      reject('S3_BUCKET', 'S3_BUCKET and S3_ACCESS_KEY_ID are required when STORAGE_DRIVER=s3');
    }
    if (env.DATABASE_URL.includes('shikkha_migrator')) {
      reject(
        'DATABASE_URL',
        'points at the migrator role. The API must connect as shikkha_app, which row-level security applies to',
      );
    }
    if (env.DATABASE_LOG_QUERIES) {
      reject(
        'DATABASE_LOG_QUERIES',
        'must be false in production; query logs contain student data',
      );
    }
    if (env.ENABLE_DEMO_HINTS) {
      reject('ENABLE_DEMO_HINTS', 'must be false in production');
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test helper — resets the memoised value so a suite can vary the environment. */
export function resetEnvCache(): void {
  cached = null;
}

export function corsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
