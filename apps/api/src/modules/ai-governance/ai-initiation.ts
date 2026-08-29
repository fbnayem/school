/**
 * AI-initiation: whether a model is behind this request, as a property of the request.
 *
 * ── Why this file exists ───────────────────────────────────────────────────────────────
 *
 * Before Phase 36 "was a model involved" was a *convention*: each AI code path remembered to
 * pass `isAiInitiated: true` when it wrote its audit row (`tool-registry.service.ts`,
 * `ai-conversation.service.ts`, `knowledge.service.ts`). A convention is fine for labelling a
 * trail after the fact. It is useless for *refusing* something, because the code that would
 * have to refuse — a guard, running before any handler — has nothing to read.
 *
 * So the fact is lifted to the request itself, with exactly one writer and one reader, and
 * `AiAutonomyGuard` decides on it.
 *
 * ── The three ways a request can be AI-initiated, and how much each is worth ───────────
 *
 *  1. **In-process** — `runAiInitiated(label, fn)`. Unforgeable: it is a code path saying
 *     "everything I call from here is on a model's behalf". This is the one that matters and
 *     the one AI features should use when they call another module's service.
 *  2. **`x-ai-initiated`** — the header the gateway sets on the calls it makes back into this
 *     API on a user's behalf. Forgeable by anyone holding a token, which is exactly why it is
 *     accepted **in one direction only**: it can *set* the flag, never clear it. A caller can
 *     therefore only ever restrict itself, and no request can talk its way out of the policy
 *     by claiming to be human.
 *  3. Nothing else. In particular the *path* is not a signal. A route living under `/ai` does
 *     not mean a model asked for it — a teacher pressing "archive this conversation" is a
 *     human act on an AI resource, and blocking it would be both wrong and a regression.
 *
 * ── What this is not ───────────────────────────────────────────────────────────────────
 *
 * A caller who simply omits the header is treated as human. That is a real limit, stated
 * plainly here and in docs/16, and it is why the autonomy guard is **defence in depth rather
 * than the primary control**. The primary control is structural and is described in docs/06
 * §1-2: `apps/ai` holds no database credentials and no identity of its own, and the entire
 * tool surface it can reach is six *read* tools. There is no path by which a model can reach
 * a mutating route today at all; this guard is what stops that from silently becoming untrue
 * the first time somebody adds a seventh tool that writes.
 *
 * ── Where the flag lives ───────────────────────────────────────────────────────────────
 *
 * On the Express request (so guards, interceptors and controllers can read it) and mirrored
 * onto the object `RequestContext` already stores in its AsyncLocalStorage (so a service six
 * frames down can read it without threading a parameter). The mirror is written through the
 * intersection type below rather than by widening `RequestContext` itself, because that
 * interface is shared infrastructure owned outside this module. Folding `aiInitiation` into
 * `common/context/request-context.ts` proper is a one-line change and the better home; until
 * then this file is the single place that knows the field's name.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';
import { currentContext, type RequestContext } from '../../common/context/request-context';

/** The header the AI gateway sets on requests it makes on a user's behalf. */
export const AI_INITIATION_HEADER = 'x-ai-initiated';

export type AiInitiationOrigin = 'header' | 'in-process';

export interface AiInitiation {
  origin: AiInitiationOrigin;
  /**
   * What declared it: the gateway's own label, or the name of the in-process caller.
   *
   * Recorded in the security event for a refusal, so an operator reading "something AI-ish
   * tried to post a payroll run" can tell which subsystem it was. Constrained to an
   * identifier shape below — it reaches a log line and a jsonb column, and an unbounded
   * header value is a log-injection vector (the same reasoning as `resolveRequestId`).
   */
  declaredBy: string;
}

/** Bounded and boring, for the same reason `RequestContextMiddleware` bounds the request id. */
const MAX_LABEL_LENGTH = 64;
const SAFE_LABEL = /^[A-Za-z0-9_.:-]+$/;
const FALLBACK_LABEL = 'unlabelled';

/**
 * `RequestContext` plus the field this module owns.
 *
 * Optional, because every request that has not passed through `markAiInitiated` legitimately
 * has no value — and "absent" must read as human rather than as unknown.
 */
type ContextWithInitiation = RequestContext & { aiInitiation?: AiInitiation };

/** The Express request, plus the same field. */
export type RequestWithInitiation = Request & { aiInitiation?: AiInitiation };

const inProcess = new AsyncLocalStorage<AiInitiation>();

/**
 * Run `fn` as an AI-initiated action.
 *
 * For AI features that call another module's service directly rather than over HTTP. Nothing
 * inside the callback can clear the marker — there is deliberately no `runAsHuman` — because
 * an escape hatch here would be used once during an incident and would then stay.
 */
export function runAiInitiated<T>(declaredBy: string, fn: () => T): T {
  return inProcess.run({ origin: 'in-process', declaredBy: normalizeLabel(declaredBy) }, fn);
}

/**
 * Read the header and, if it is present and non-empty, mark the request.
 *
 * One-way: a header saying `false` still marks the request, because the only value a caller
 * could gain from being believed on that point is escaping the policy. The presence of the
 * header is the signal; its value is only a label.
 */
export function markAiInitiatedFromHeader(request: RequestWithInitiation): AiInitiation | null {
  const raw = request.headers[AI_INITIATION_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim().length === 0) return null;

  const initiation: AiInitiation = { origin: 'header', declaredBy: normalizeLabel(value) };
  markAiInitiated(request, initiation);
  return initiation;
}

/** Attach the marker to the request and mirror it into the ambient request context. */
export function markAiInitiated(request: RequestWithInitiation, initiation: AiInitiation): void {
  request.aiInitiation = initiation;
  const context = currentContext() as ContextWithInitiation | null;
  if (context) context.aiInitiation = initiation;
}

/**
 * Whatever marked this request, or null when a human did.
 *
 * The in-process marker wins over the header: it is the stronger claim, and a gateway call
 * that happens to run inside an already-AI-initiated frame is AI-initiated either way.
 */
export function aiInitiationOf(request: RequestWithInitiation | undefined): AiInitiation | null {
  return inProcess.getStore() ?? request?.aiInitiation ?? null;
}

/**
 * The same answer with no request to hand — for a service deep in a call stack that wants to
 * know whether a model is behind what it is about to do.
 */
export function currentAiInitiation(): AiInitiation | null {
  const ambient = inProcess.getStore();
  if (ambient) return ambient;
  return (currentContext() as ContextWithInitiation | null)?.aiInitiation ?? null;
}

/** True when a model is behind the current call. The one-liner most callers want. */
export function isAiInitiated(): boolean {
  return currentAiInitiation() !== null;
}

function normalizeLabel(value: string): string {
  const trimmed = value.trim().slice(0, MAX_LABEL_LENGTH);
  return SAFE_LABEL.test(trimmed) ? trimmed : FALLBACK_LABEL;
}
