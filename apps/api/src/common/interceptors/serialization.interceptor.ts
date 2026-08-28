/**
 * Response serialisation.
 *
 * Two jobs, both about not leaking things:
 *
 *  1. Strips the `__audit` hint that services attach for the audit interceptor. It is
 *     internal plumbing and has no business on the wire.
 *  2. Removes fields that must never be serialised, wherever they appear in the response
 *     tree. A service that accidentally returns a whole user row — including `passwordHash`
 *     — is a mistake that will happen; this makes it harmless rather than catastrophic.
 */

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';

const NEVER_SERIALIZED = new Set([
  '__audit',
  'passwordHash',
  'password_hash',
  'tokenHash',
  'token_hash',
  'mfaSecret',
  'mfa_secret',
  'mfaRecoveryCodes',
  'mfa_recovery_codes',
  'searchVector',
  'search_vector',
]);

@Injectable()
export class SerializationInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((value) => strip(value, 0)));
  }
}

/**
 * Depth-bounded so a cyclic or pathologically deep structure cannot hang the response.
 * Buffers and Dates are returned untouched — walking them would corrupt them.
 */
function strip(value: unknown, depth: number): unknown {
  if (depth > 12) return value;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map((item) => strip(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_SERIALIZED.has(key)) continue;
    out[key] = strip(item, depth + 1);
  }
  return out;
}
