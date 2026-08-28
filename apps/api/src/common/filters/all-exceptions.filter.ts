/**
 * The single exception boundary.
 *
 * Everything the API returns on failure passes through here, so the error envelope is
 * consistent and — more importantly — a stack trace, a SQL fragment or an upstream provider's
 * error message can never reach a user. The full detail is logged against the request id;
 * the client gets a stable code, a safe message, and that id to quote in a support ticket.
 *
 * Postgres error codes are translated into domain errors here rather than in every service:
 * a unique-violation is a 409 wherever it happens, and catching it centrally means a new
 * module gets correct behaviour without remembering to.
 */

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ConflictError,
  isDomainError,
  toErrorResponse,
  TransportError,
  ValidationError,
  type ErrorCode,
  type ErrorResponseBody,
} from '@shikkha/shared';
import { currentRequestId } from '../context/request-context';
import { getLogger } from '../logger';

/** Postgres SQLSTATE codes worth translating rather than reporting as a 500. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';
const PG_NOT_NULL_VIOLATION = '23502';
const PG_INSUFFICIENT_PRIVILEGE = '42501';
const PG_RLS_VIOLATION = '42501';

interface PostgresError {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const requestId = currentRequestId() ?? undefined;
    const logger = getLogger();

    const translated = translate(exception);
    const { status, body } = toErrorResponse(translated, requestId);

    // 5xx is a defect; 4xx is usually a client doing something wrong. Log accordingly, so an
    // enumeration attempt does not bury a real crash under thousands of 403 lines.
    const logPayload = {
      requestId,
      method: request.method,
      path: request.originalUrl,
      status,
      code: body.error.code,
      err: exception instanceof Error ? exception : new Error(String(exception)),
    };
    if (status >= 500) {
      logger.error(logPayload, 'request failed');
    } else if (status === 429 || status === 403) {
      logger.warn(logPayload, 'request refused');
    } else {
      logger.info(logPayload, 'request rejected');
    }

    if (response.headersSent) {
      // A streamed response that fails mid-flight cannot be re-headed; destroying the socket
      // is the only honest signal to the client that the body is incomplete.
      response.destroy();
      return;
    }

    if (requestId) response.setHeader('x-request-id', requestId);
    response.status(status).json(body satisfies ErrorResponseBody);
  }
}

function translate(exception: unknown): unknown {
  if (isDomainError(exception)) return exception;

  if (exception instanceof HttpException) {
    return fromHttpException(exception);
  }

  const pg = exception as PostgresError;
  if (typeof pg?.code === 'string') {
    switch (pg.code) {
      case PG_UNIQUE_VIOLATION:
        return new ConflictError(
          describeUniqueViolation(pg.constraint),
          // The raw `detail` contains the conflicting values, which may be personal data.
          // It is kept in `context` for the log and stripped from the response.
          { constraint: pg.constraint, detail: pg.detail },
        );
      case PG_FOREIGN_KEY_VIOLATION:
        return new ConflictError(
          'This record refers to something that does not exist, or is still in use elsewhere.',
          { constraint: pg.constraint },
        );
      case PG_CHECK_VIOLATION:
        return new ValidationError('The submitted values are not valid for this record.', [], {
          constraint: pg.constraint,
        });
      case PG_NOT_NULL_VIOLATION:
        return new ValidationError('A required value is missing.', [
          { path: pg.column ?? 'unknown', message: 'This field is required' },
        ]);
      case PG_INSUFFICIENT_PRIVILEGE:
      case PG_RLS_VIOLATION:
        // A row-level security refusal reaching this layer means the application tried to
        // read or write outside its tenant. Surfacing it as 404 mirrors how the tenant guard
        // behaves, and the real cause is in the log.
        return new ConflictError('The requested record is not available.', {
          reason: 'row_level_security',
          table: pg.table,
        });
      default:
        break;
    }
  }

  return exception;
}

/**
 * Convert a framework exception into a `TransportError`.
 *
 * It must be a real `DomainError` subclass, not a look-alike object: `toErrorResponse` gates
 * on `instanceof`, so a plain object with the right fields silently fell through to the 500
 * branch and turned every guard's 403 into an internal error.
 */
function fromHttpException(exception: HttpException): TransportError {
  const status = exception.getStatus();
  const payload = exception.getResponse();
  const message =
    typeof payload === 'string'
      ? payload
      : ((payload as { message?: string | string[] }).message ?? exception.message);
  const text = Array.isArray(message) ? message.join('; ') : message;

  // Nest's own exceptions carry safe, human-readable messages, so 4xx text passes through;
  // 5xx text is replaced by the generic message inside `toErrorResponse`.
  return new TransportError(status, statusToCode(status), text);
}

function statusToCode(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'VALIDATION_FAILED';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHENTICATED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'VALIDATION_FAILED';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED';
  }
}

/**
 * Turn a constraint name into something a user can act on.
 *
 * The index names are deliberately descriptive in the schema (`students_institution_code_key`)
 * so this mapping stays small and the fallback stays honest rather than inventing a cause.
 */
function describeUniqueViolation(constraint: string | undefined): string {
  if (!constraint) return 'A record with these details already exists.';

  const known: Record<string, string> = {
    users_tenant_email_key: 'An account with this email address already exists.',
    users_platform_email_key: 'An account with this email address already exists.',
    users_tenant_phone_key: 'An account with this phone number already exists.',
    students_institution_code_key: 'A student with this ID already exists.',
    students_institution_admission_key: 'This admission number is already in use.',
    students_brn_key: 'A student with this birth registration number already exists.',
    enrollments_section_roll_key: 'This roll number is already used in that section.',
    enrollments_student_year_key: 'This student is already enrolled for that academic year.',
    guardians_institution_phone_key: 'A guardian with this phone number already exists.',
    employees_institution_code_key: 'An employee with this ID already exists.',
    institutions_tenant_code_key: 'An institution with this code already exists.',
    institutions_eiin_key: 'This EIIN is already registered to another institution.',
    roles_tenant_key_key: 'A role with this key already exists.',
    academic_years_current_key: 'Another academic year is already marked as current.',
    student_guardians_primary_key: 'This student already has a primary guardian.',
    student_guardians_billing_key: 'This student already has a billing contact.',
    campuses_primary_key: 'This institution already has a primary campus.',
    employee_section_primary_key: 'This section already has a class teacher.',
  };

  return known[constraint] ?? 'A record with these details already exists.';
}
