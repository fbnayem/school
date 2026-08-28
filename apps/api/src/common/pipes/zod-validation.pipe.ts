/**
 * Zod validation pipe.
 *
 * Bodies, queries and params are validated against the same schemas the web app uses for its
 * forms (`@shikkha/validation`), which is what makes "shared schemas" real rather than
 * aspirational. The server never trusts the client's validation — it re-runs it.
 *
 * The pipe returns the **parsed** value, not the original. That matters: Zod strips unknown
 * keys, coerces types and applies transforms, so a request body carrying an extra
 * `isPlatformAdmin: true` field cannot reach a service that spreads it into an insert. Mass
 * assignment is prevented by construction rather than by remembering to pick fields.
 */

import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { type ZodError, type ZodSchema } from 'zod';
import { ValidationError, type FieldIssue } from '@shikkha/shared';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new ValidationError('The submitted data is not valid', toFieldIssues(result.error));
  }
}

/** Convenience factory so controllers read as `@Body(zodBody(createStudentSchema))`. */
export function zodBody(schema: ZodSchema): ZodValidationPipe {
  return new ZodValidationPipe(schema);
}

export function zodQuery(schema: ZodSchema): ZodValidationPipe {
  return new ZodValidationPipe(schema);
}

export function zodParam(schema: ZodSchema): ZodValidationPipe {
  return new ZodValidationPipe(schema);
}

/**
 * Flatten a ZodError into the wire format.
 *
 * Paths are dotted with array indices, e.g. `guardians.0.phone`, so a form library can map an
 * issue straight back to the field that produced it — including inside repeatable sections,
 * which is where a flat field list stops being usable.
 */
export function toFieldIssues(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
    code: issue.code,
  }));
}
