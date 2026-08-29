/**
 * A small Zod → JSON Schema converter, for the tool manifest.
 *
 * Why hand-written rather than a dependency: `zod-to-json-schema` is not in `pnpm-lock.yaml`,
 * and adding a package to a production dependency tree to serve six argument schemas is a
 * poor trade — it brings a supply-chain surface and a version to track in exchange for
 * roughly a hundred lines. This covers exactly the Zod constructs
 * `packages/validation/src/ai-tools.ts` uses, and **throws on anything else**.
 *
 * Throwing is the important decision. A converter that silently emits `{}` for a shape it does
 * not understand produces a manifest that tells the model "this parameter accepts anything",
 * the model sends something plausible, and Zod rejects it at invoke time with a 422 the model
 * cannot learn from. Failing loudly at boot — the registry converts every schema when it is
 * constructed — turns that into a startup error the developer sees instead.
 *
 * The output targets JSON Schema draft 2020-12 with the subset every model provider's
 * function-calling API accepts: `type`, `properties`, `required`, `enum`, `items`,
 * `additionalProperties`, `description`, and the numeric/string bounds.
 */

import { z, type ZodTypeAny } from 'zod';

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  anyOf?: JsonSchema[];
  default?: unknown;
}

const Kind = z.ZodFirstPartyTypeKind;

/**
 * `_def.typeName` is Zod 3's internal discriminant. It is stable across the 3.x line and is
 * what every converter in the ecosystem reads; when the workspace moves to Zod 4 this is the
 * one function that has to change, which is the reason the knowledge of it is confined here.
 */
function typeNameOf(schema: ZodTypeAny): z.ZodFirstPartyTypeKind {
  return (schema._def as { typeName: z.ZodFirstPartyTypeKind }).typeName;
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const converted = convert(schema);
  const description = schema.description;
  // The description lives on the outer wrapper (`.optional().describe(...)` puts it there),
  // so it is applied after unwrapping rather than inside `convert`.
  return description && !converted.description ? { ...converted, description } : converted;
}

function convert(schema: ZodTypeAny): JsonSchema {
  const typeName = typeNameOf(schema);

  switch (typeName) {
    // ── Wrappers. Each is transparent for schema purposes; optionality is expressed by the
    // parent object's `required` list, not by a keyword on the child. ────────────────────
    case Kind.ZodOptional:
    case Kind.ZodNullable:
      return zodToJsonSchema((schema._def as { innerType: ZodTypeAny }).innerType);

    case Kind.ZodDefault: {
      const def = schema._def as { innerType: ZodTypeAny; defaultValue: () => unknown };
      return { ...zodToJsonSchema(def.innerType), default: def.defaultValue() };
    }

    // `.trim()`, `.superRefine()` and `.transform()` all produce a ZodEffects. The effect
    // itself has no JSON Schema expression — a cross-field rule like "exactly one of
    // studentId or q" cannot be stated in the subset providers accept — so the *shape* is
    // published and the rule is enforced at invoke time. The tool description carries the
    // rule in prose, which is what the model can actually act on.
    case Kind.ZodEffects:
      return zodToJsonSchema((schema._def as { schema: ZodTypeAny }).schema);

    case Kind.ZodObject:
      return convertObject(schema as z.ZodObject<z.ZodRawShape>);

    case Kind.ZodString:
      return convertString(schema as z.ZodString);

    case Kind.ZodNumber:
      return convertNumber(schema as z.ZodNumber);

    case Kind.ZodBoolean:
      return { type: 'boolean' };

    case Kind.ZodEnum:
      return { type: 'string', enum: [...(schema._def as { values: string[] }).values] };

    case Kind.ZodLiteral:
      return { const: (schema._def as { value: unknown }).value };

    case Kind.ZodArray: {
      const def = schema._def as {
        type: ZodTypeAny;
        minLength: { value: number } | null;
        maxLength: { value: number } | null;
      };
      const out: JsonSchema = { type: 'array', items: zodToJsonSchema(def.type) };
      if (def.minLength) out.minItems = def.minLength.value;
      if (def.maxLength) out.maxItems = def.maxLength.value;
      return out;
    }

    case Kind.ZodUnion: {
      const options = (schema._def as { options: ZodTypeAny[] }).options;
      return { anyOf: options.map((option) => zodToJsonSchema(option)) };
    }

    // A `z.record(z.unknown())` — the invocation envelope's `arguments` bag. Its real shape
    // is the tool's own schema, resolved at invoke time, so all that can be said here is
    // "an object".
    case Kind.ZodRecord:
      return { type: 'object' };

    default:
      throw new Error(
        `zodToJsonSchema does not handle ${typeName}. Extend it deliberately rather than ` +
          `letting the manifest describe a parameter it cannot describe.`,
      );
  }
}

function convertObject(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const shape = schema.shape;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = zodToJsonSchema(value);
    // `.default()` makes a field optional on the wire even though the parsed type has it,
    // so both wrappers have to be consulted — `isOptional()` covers both in Zod 3.
    if (!value.isOptional()) required.push(key);
  }

  const out: JsonSchema = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  // `.strict()` on the source schema; published so the model is told an invented parameter
  // will be refused rather than discovering it through a 422.
  out.additionalProperties = (schema._def as { unknownKeys?: string }).unknownKeys !== 'strict';
  return out;
}

function convertString(schema: z.ZodString): JsonSchema {
  const out: JsonSchema = { type: 'string' };
  const checks = (schema._def as { checks: Array<Record<string, unknown>> }).checks ?? [];

  for (const check of checks) {
    switch (check['kind']) {
      case 'min':
        out.minLength = check['value'] as number;
        break;
      case 'max':
        out.maxLength = check['value'] as number;
        break;
      case 'length':
        out.minLength = check['value'] as number;
        out.maxLength = check['value'] as number;
        break;
      case 'uuid':
        out.format = 'uuid';
        break;
      case 'email':
        out.format = 'email';
        break;
      case 'regex':
        out.pattern = (check['regex'] as RegExp).source;
        break;
      case 'trim':
      case 'toLowerCase':
      case 'toUpperCase':
        // Normalisations, not constraints. Nothing to publish.
        break;
      default:
        throw new Error(`zodToJsonSchema does not handle the string check "${check['kind']}"`);
    }
  }
  return out;
}

function convertNumber(schema: z.ZodNumber): JsonSchema {
  const out: JsonSchema = { type: 'number' };
  const checks = (schema._def as { checks: Array<Record<string, unknown>> }).checks ?? [];

  for (const check of checks) {
    switch (check['kind']) {
      case 'int':
        out.type = 'integer';
        break;
      case 'min':
        out.minimum = check['value'] as number;
        break;
      case 'max':
        out.maximum = check['value'] as number;
        break;
      default:
        throw new Error(`zodToJsonSchema does not handle the number check "${check['kind']}"`);
    }
  }
  return out;
}
