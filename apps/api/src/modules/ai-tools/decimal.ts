/**
 * Fixed-point helpers for the numbers the tools report.
 *
 * Money never comes through here — that is `Money` from `@shikkha/shared`, and
 * `finance.outstanding` uses it. What comes through here is percentages and mark averages:
 * quantities that are not currency but are still shown to a parent and quoted back by a
 * model, and so must not be produced by `(a / b * 100).toFixed(2)`.
 *
 * The objection to `toFixed` is not that it is inaccurate at one call site. It is that
 * `0.1 + 0.2` and banker's-versus-half-up rounding turn "the same percentage" computed in two
 * places into two different strings, and the person noticing is a parent whose child's
 * attendance reads 87.34% on the portal and 87.35% in a copilot summary. Everything below is
 * integer arithmetic on hundredths with explicit half-up rounding, so there is one answer.
 */

/** Hundredths as an integer: 8734 means 87.34. `null` when the denominator is zero. */
export function ratioToHundredths(numerator: number, denominator: number): number | null {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new Error('ratioToHundredths takes integers; scale the inputs before calling it');
  }
  if (denominator === 0) return null;

  const scaled = numerator * 10_000;
  const quotient = Math.floor(scaled / denominator);
  const remainder = scaled - quotient * denominator;
  // Half-up, the convention every mark sheet in the country uses.
  return remainder * 2 >= denominator ? quotient + 1 : quotient;
}

/** Render hundredths as the canonical two-decimal string the API returns elsewhere. */
export function formatHundredths(hundredths: number | null): string | null {
  if (hundredths === null) return null;
  const sign = hundredths < 0 ? '-' : '';
  const absolute = Math.abs(hundredths);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/**
 * Parse a `numeric(p,2)` string as Postgres returns it into hundredths.
 *
 * Rejects rather than rounds a third decimal place, for the same reason `Money` does: a value
 * with more precision than the column is supposed to hold means an assumption somewhere is
 * wrong, and silently dropping the digit hides it.
 */
export function decimalToHundredths(value: string): number {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Not a two-decimal numeric string: ${JSON.stringify(value)}`);
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '').padEnd(2, '0'));
  return sign * (whole * 100 + fraction);
}

/** Mean of a set of hundredths, half-up. `null` for an empty set — not zero, which is a mark. */
export function averageHundredths(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  const quotient = Math.floor(total / values.length);
  const remainder = total - quotient * values.length;
  return remainder * 2 >= values.length ? quotient + 1 : quotient;
}
