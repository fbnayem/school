/**
 * Structured logging.
 *
 * Two properties matter more than the choice of library:
 *
 *  1. **Every line carries the request id**, so a support ticket quoting one id retrieves the
 *     whole request including the failure. This is done through the async context rather than
 *     by passing a logger around.
 *  2. **Personal data never reaches the logs.** School records are the most sensitive thing
 *     this system holds, and a log aggregator is a far softer target than the database. The
 *     redaction list below is applied by pino at serialisation time, so it also catches
 *     objects that were logged accidentally.
 */

import pino, { type Logger } from 'pino';
import { currentContext } from './context/request-context';

/**
 * Paths redacted from every log line.
 *
 * Two categories: credentials (a leak here is an immediate compromise) and personal data
 * (a leak here is a privacy incident). Both are removed rather than truncated, because a
 * partial hash or a partial NID is still useful to an attacker.
 */
const REDACTED_PATHS = [
  'password',
  'passwordHash',
  'password_hash',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'authorization',
  'cookie',
  'mfaSecret',
  'mfaRecoveryCodes',
  'secret',
  'apiKey',
  'nationalId',
  'national_id',
  'birthRegistrationNumber',
  'birth_registration_number',
  'bankAccountNumber',
  'bank_account_number',
  'medicalConditions',
  'allergies',
  'specialNeeds',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.nationalId',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'body.password',
  'body.currentPassword',
  'body.newPassword',
  'body.token',
];

let logger: Logger | null = null;

export interface LoggerOptions {
  level: string;
  pretty: boolean;
  environment: string;
}

export function initLogger(options: LoggerOptions): Logger {
  logger = pino({
    level: options.level,
    base: { service: 'shikkha-api', env: options.environment },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    // ISO timestamps: log aggregators and humans both read them, unlike epoch millis.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Attach the request id to every line without the caller having to remember.
    mixin() {
      const context = currentContext();
      if (!context) return {};
      return {
        requestId: context.requestId,
        userId: context.principal?.userId,
        tenantId: context.tenantId,
      };
    },
    transport: options.pretty
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        }
      : undefined,
  });
  return logger;
}

export function getLogger(): Logger {
  // A logger that has not been initialised is a boot-order bug, but crashing the process to
  // report it would be worse than logging to stderr at a sane default.
  logger ??= pino({ level: 'info', redact: { paths: REDACTED_PATHS, censor: '[redacted]' } });
  return logger;
}

/** A child logger tagged with a module name, for use inside a service. */
export function moduleLogger(name: string): Logger {
  return getLogger().child({ module: name });
}
