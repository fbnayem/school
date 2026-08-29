/**
 * The contract every AI tool implements.
 *
 * A tool is not a special kind of thing. It is a permission-checked read with a declared
 * argument schema and a declared minimum result — the same shape a controller method has,
 * expressed as data so the registry can enumerate it for the manifest and dispatch to it by
 * name. Nothing here can write, and nothing here takes an institution id as an argument.
 */

import type { ZodTypeAny } from 'zod';
import type { Permission, Principal } from '@shikkha/permissions';
import type { AiToolUsage } from '../ports';

export interface AiToolContext {
  principal: Principal;
  /** Resolved and validated by `TenantGuard` from `x-institution-id`, never from an argument. */
  institutionId: string;
}

/** Where an answer came from. Retrieval tools populate it; database tools do not. */
export interface AiToolCitation {
  documentId: string;
  documentTitle: string;
  chunkId: string;
}

export interface AiToolResult<T = unknown> {
  data: T;
  /**
   * How many records the answer stands for.
   *
   * Recorded in the audit row so "this copilot session read 4,000 student records" is
   * answerable months later. For an aggregate it is the number of underlying rows the
   * aggregate consumed, not the number of numbers returned — the point of the field is to
   * measure exposure, and an aggregate over 4,000 rows has seen 4,000 rows.
   */
  rowCount: number;
  citations?: AiToolCitation[];
  /** Omitted by tools that make no model call; the registry substitutes a zero record. */
  usage?: AiToolUsage;
}

export interface AiTool<TArgs = unknown> {
  /** Dotted, stable, and part of the model's vocabulary. Renaming one is a breaking change. */
  readonly name: string;
  /**
   * What the tool answers, in the words the model will read.
   *
   * Written for a model rather than for a developer: it states what comes back, what does
   * *not* come back, and any cross-field rule the JSON Schema subset cannot express.
   */
  readonly description: string;
  readonly schema: ZodTypeAny;
  /**
   * Any one of these permits the tool — a disjunction, because the same question is legitimate
   * from several directions: a class teacher holds `attendance.view.assigned`, a principal
   * `attendance.view.all`, and a guardian `attendance.view.own`. Which rows each of them then
   * sees is decided on the data, not here.
   */
  readonly permissions: readonly Permission[];
  /**
   * Argument names whose value is free text.
   *
   * Declared explicitly rather than sniffed at runtime, because a heuristic ("is it a uuid?")
   * is the kind of rule that silently stops matching after a schema change and takes a
   * defence with it. The registry uses this to build `promptSafeArguments` — see
   * `tool-registry.service.ts`. Tools whose arguments are all ids, dates and numbers declare
   * an empty list, which is a statement rather than an omission.
   */
  readonly freeTextArguments: readonly string[];

  execute(context: AiToolContext, args: TArgs): Promise<AiToolResult>;
}

/** Narrow the principal type at call sites without importing from two places. */
export type { Principal };
