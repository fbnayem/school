/**
 * Inference prices and exact cost arithmetic.
 *
 * ── WHERE TO UPDATE PRICES ────────────────────────────────────────────────────────────
 * `MODEL_PRICES` below is **configuration that happens to live in source**. Vendors change
 * list prices several times a year; when they do, edit this table, note the date, and ship
 * it like any other change. It is not derived from anything and nothing else in the codebase
 * hard-codes a price. The figures here are USD per 1,000,000 tokens as published at the time
 * of writing (2026-08) and MUST be re-checked against the vendor's own pricing page before a
 * billing cycle is trusted — a stale table under-reports a school's bill, which is the one
 * failure mode this whole module exists to prevent.
 * ──────────────────────────────────────────────────────────────────────────────────────
 *
 * The arithmetic is exact and integral, like every other money path in this codebase
 * (ADR-004). Costs are counted in **ten-thousandths of a currency unit** — `bigint`, matching
 * the `numeric(14, 4)` column — because inference is priced in fractions of a cent and a
 * single copilot turn frequently costs less than one poisa. Rounding each call to two
 * decimals would round most of them to zero and the month's total to nothing.
 *
 * `Money` is deliberately *not* the internal representation: it is a two-decimal type by
 * construction, so `Money.fromDecimalString('0.0345')` throws. `Money` is used at the one
 * place a figure is genuinely presented as settlement currency — see `roundToCurrency` —
 * and the four-decimal string remains the authority everywhere else.
 */

import { Money, type CurrencyCode } from '@shikkha/shared';

/** Price of one model, in the price sheet's currency, per 1,000,000 tokens. */
export interface ModelPrice {
  /** Decimal string with at most four places, e.g. "0.1500". */
  inputPerMillion: string;
  outputPerMillion: string;
}

/**
 * The price sheet. USD per million tokens, recorded 2026-08. See the header before editing.
 *
 * The `mock-*` entries are as real as the rest: the mock adapter is a working provider used
 * in development, demos and tests, and metering it with a fabricated price of zero would
 * make every budget test vacuous.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // ── Local / deterministic adapter ───────────────────────────────────────────────────
  'mock-completion-1': { inputPerMillion: '0.1500', outputPerMillion: '0.6000' },
  'mock-embedding-1': { inputPerMillion: '0.0200', outputPerMillion: '0.0000' },

  // ── OpenAI ──────────────────────────────────────────────────────────────────────────
  'gpt-4o-mini': { inputPerMillion: '0.1500', outputPerMillion: '0.6000' },
  'gpt-4o': { inputPerMillion: '2.5000', outputPerMillion: '10.0000' },
  'text-embedding-3-small': { inputPerMillion: '0.0200', outputPerMillion: '0.0000' },
  'text-embedding-3-large': { inputPerMillion: '0.1300', outputPerMillion: '0.0000' },

  // ── Anthropic ───────────────────────────────────────────────────────────────────────
  'claude-haiku-4-5': { inputPerMillion: '1.0000', outputPerMillion: '5.0000' },
  'claude-sonnet-4-5': { inputPerMillion: '3.0000', outputPerMillion: '15.0000' },

  // ── Google ──────────────────────────────────────────────────────────────────────────
  'gemini-2.5-flash': { inputPerMillion: '0.3000', outputPerMillion: '2.5000' },
  'gemini-2.5-pro': { inputPerMillion: '1.2500', outputPerMillion: '10.0000' },
  'text-embedding-004': { inputPerMillion: '0.0250', outputPerMillion: '0.0000' },
};

/**
 * What an unlisted model costs.
 *
 * Deliberately the most expensive row in the table rather than zero, and deliberately not an
 * exception. Throwing would abort a request whose cost the vendor has *already* charged;
 * charging zero would under-report the bill and let a school blow through a budget that
 * thought it was untouched. Over-estimating errs toward refusing spend the school did not
 * authorise, which is the safe direction — and `priceOf` reports the fallback so the caller
 * can log it and somebody can add the row.
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = {
  inputPerMillion: '3.0000',
  outputPerMillion: '15.0000',
};

/** The scale of the `numeric(14, 4)` cost columns: 10^4 sub-units per currency unit. */
const COST_SCALE = 10_000n;
const TOKENS_PER_PRICE_UNIT = 1_000_000n;

export interface ResolvedPrice {
  price: ModelPrice;
  /** True when the model was not in the table and `UNKNOWN_MODEL_PRICE` was used. */
  isFallback: boolean;
}

export function priceOf(model: string): ResolvedPrice {
  const price = MODEL_PRICES[model];
  return price ? { price, isFallback: false } : { price: UNKNOWN_MODEL_PRICE, isFallback: true };
}

/**
 * Parse a decimal string into ten-thousandths. Strict: more than four decimal places is an
 * error rather than a silent round, because a price sheet with five is a typo.
 */
export function parseCost(value: string): bigint {
  const match = /^(-)?(\d+)(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid cost literal: ${JSON.stringify(value)}`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2] ?? '0';
  const fraction = (match[3] ?? '').padEnd(4, '0');
  return sign * (BigInt(whole) * COST_SCALE + BigInt(fraction));
}

/** Render ten-thousandths back to the canonical four-decimal wire and column form. */
export function formatCost(units: bigint): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / COST_SCALE;
  const fraction = (magnitude % COST_SCALE).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Integer division rounding half away from zero.
 *
 * Half *away from zero* rather than half up, so a compensating credit and the charge it
 * reverses round symmetrically and a correction cannot leave a residue behind. This is the
 * same rule `Money.percentage` applies, for the same reason.
 */
function divideRoundHalf(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * The cost of one call, in ten-thousandths.
 *
 *   cost = (inputTokens × inputPerMillion + outputTokens × outputPerMillion) ÷ 1,000,000
 *
 * evaluated entirely in `bigint`, with a single rounding step at the end so a two-part price
 * does not round twice. Token counts may be negative: a compensating usage event credits a
 * double-counted call back, and it must produce exactly the negation of the original.
 */
export function computeAiCostUnits(
  model: string,
  inputTokens: number,
  outputTokens: number,
): bigint {
  const { price } = priceOf(model);
  const numerator =
    BigInt(Math.trunc(inputTokens)) * parseCost(price.inputPerMillion) +
    BigInt(Math.trunc(outputTokens)) * parseCost(price.outputPerMillion);
  return divideRoundHalf(numerator, TOKENS_PER_PRICE_UNIT);
}

/** The same figure as the four-decimal string the `numeric(14, 4)` column stores. */
export function computeAiCostDecimal(
  model: string,
  inputTokens: number,
  outputTokens: number,
): string {
  return formatCost(computeAiCostUnits(model, inputTokens, outputTokens));
}

/** Sum a set of four-decimal cost strings exactly. */
export function sumCosts(values: readonly string[]): string {
  return formatCost(values.reduce<bigint>((total, value) => total + parseCost(value), 0n));
}

/**
 * The one place a four-decimal figure becomes settlement currency.
 *
 * Used for display and for anything that will eventually be invoiced, where a number that is
 * not a whole minor unit is not a number a school can pay. Rounds half away from zero, and
 * the exact four-decimal figure remains the authority — this is a presentation of the total,
 * never a replacement for it.
 */
export function roundToCurrency(costDecimal: string, currency: CurrencyCode = 'USD'): Money {
  const units = parseCost(costDecimal);
  // Ten-thousandths → hundredths (the minor unit of both currencies Money supports).
  const minor = divideRoundHalf(units, 100n);
  return Money.fromMinor(minor, currency);
}

/** `Money` supports a closed set of currencies; anything else is reported, never guessed. */
export function isSupportedCurrency(value: string): value is CurrencyCode {
  return value === 'BDT' || value === 'USD';
}
