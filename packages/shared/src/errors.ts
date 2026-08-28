/**
 * Domain error taxonomy.
 *
 * These are transport-agnostic on purpose — the API maps them to HTTP status codes in one
 * exception filter, and a future queue worker or gRPC surface can map them differently.
 * Services throw these; they never throw `HttpException`.
 *
 * Every error carries a stable machine-readable `code` so clients can branch on behaviour
 * without string-matching human-readable messages.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'RATE_LIMITED'
  | 'TENANT_MISMATCH'
  | 'IMMUTABLE_RECORD'
  | 'INSUFFICIENT_BALANCE'
  | 'WORKFLOW_STATE_INVALID'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR';

export interface FieldIssue {
  path: string;
  message: string;
  code?: string;
}

export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  /** Suggested HTTP status. The transport layer owns the final decision. */
  abstract readonly status: number;
  /** Safe to show a user. Errors that are not safe put detail in `context` instead. */
  readonly isPublic: boolean = true;
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.context = context;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED' as const;
  readonly status = 422;
  readonly issues: FieldIssue[];

  constructor(message: string, issues: FieldIssue[] = [], context: Record<string, unknown> = {}) {
    super(message, context);
    this.issues = issues;
  }
}

export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED' as const;
  readonly status = 401;

  constructor(message = 'Authentication is required') {
    super(message);
  }
}

/**
 * Authorization failure.
 *
 * `permission` is recorded for the audit trail and for developer-facing logs, but the
 * message returned to the client stays generic — telling an attacker exactly which
 * permission they lack is free reconnaissance.
 */
export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN' as const;
  readonly status = 403;

  constructor(
    public readonly permission?: string,
    message = 'You do not have permission to perform this action',
  ) {
    super(message, permission ? { permission } : {});
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND' as const;
  readonly status = 404;

  constructor(resource: string, id?: string) {
    super(id ? `${resource} ${id} was not found` : `${resource} was not found`, { resource, id });
  }
}

export class ConflictError extends DomainError {
  readonly code = 'CONFLICT' as const;
  readonly status = 409;
}

export class PreconditionFailedError extends DomainError {
  readonly code = 'PRECONDITION_FAILED' as const;
  readonly status = 412;
}

export class RateLimitedError extends DomainError {
  readonly code = 'RATE_LIMITED' as const;
  readonly status = 429;

  constructor(public readonly retryAfterSeconds: number) {
    super('Too many requests. Please try again shortly.', { retryAfterSeconds });
  }
}

/**
 * A cross-tenant access attempt.
 *
 * Deliberately reported to the client as 404, not 403: confirming that a resource exists in
 * another tenant is itself a leak. The distinct error type exists so the security log can
 * record what actually happened, which a plain `NotFoundError` would hide.
 */
export class TenantMismatchError extends DomainError {
  readonly code = 'TENANT_MISMATCH' as const;
  readonly status = 404;
  override readonly isPublic = false;

  constructor(resource: string, resourceId: string, expectedTenant: string, actualTenant: string) {
    super(`${resource} was not found`, { resource, resourceId, expectedTenant, actualTenant });
  }
}

/** Attempted mutation of a published result, settled invoice, posted journal entry, etc. */
export class ImmutableRecordError extends DomainError {
  readonly code = 'IMMUTABLE_RECORD' as const;
  readonly status = 409;

  constructor(resource: string, reason: string) {
    super(`${resource} can no longer be modified: ${reason}`, { resource, reason });
  }
}

export class WorkflowStateError extends DomainError {
  readonly code = 'WORKFLOW_STATE_INVALID' as const;
  readonly status = 409;

  constructor(from: string, to: string, entity = 'record') {
    super(`Cannot move ${entity} from ${from} to ${to}`, { from, to, entity });
  }
}

/** A third-party integration failed. The upstream detail is never shown to end users. */
export class ExternalServiceError extends DomainError {
  readonly code = 'EXTERNAL_SERVICE_ERROR' as const;
  readonly status = 502;
  override readonly isPublic = false;

  constructor(
    public readonly service: string,
    detail: string,
    context: Record<string, unknown> = {},
  ) {
    super(`The ${service} service is unavailable`, { service, detail, ...context });
  }
}

export class NotImplementedError extends DomainError {
  readonly code = 'NOT_IMPLEMENTED' as const;
  readonly status = 501;
}

export class InternalError extends DomainError {
  readonly code = 'INTERNAL_ERROR' as const;
  readonly status = 500;
  override readonly isPublic = false;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
  }
}

/**
 * Wraps a transport-level error (a framework HttpException) so it flows through the same
 * envelope as a domain error.
 *
 * Without this, the exception filter had to hand-build a response for framework errors, and a
 * plain object failed the `instanceof DomainError` check in `toErrorResponse` — turning every
 * 403 from a guard into a 500. Making it a real subclass means there is exactly one code path
 * for producing an error response.
 */
export class TransportError extends DomainError {
  readonly code: ErrorCode;
  readonly status: number;
  override readonly isPublic: boolean;

  constructor(status: number, code: ErrorCode, message: string, isPublic = status < 500) {
    super(message);
    this.status = status;
    this.code = code;
    this.isPublic = isPublic;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** The single error envelope shape returned by the API. */
export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    issues?: FieldIssue[];
    requestId?: string;
  };
}

export function toErrorResponse(
  error: unknown,
  requestId?: string,
): { status: number; body: ErrorResponseBody } {
  if (isDomainError(error)) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          // Non-public errors are replaced wholesale; the real message is logged, not returned.
          message: error.isPublic ? error.message : genericMessageFor(error.status),
          ...(error instanceof ValidationError && error.issues.length
            ? { issues: error.issues }
            : {}),
          ...(requestId ? { requestId } : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: genericMessageFor(500),
        ...(requestId ? { requestId } : {}),
      },
    },
  };
}

function genericMessageFor(status: number): string {
  if (status === 404) return 'The requested resource was not found';
  if (status === 502) return 'An upstream service is currently unavailable';
  return 'Something went wrong. If this continues, contact your administrator with the request ID.';
}
