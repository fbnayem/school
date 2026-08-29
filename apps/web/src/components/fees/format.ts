/**
 * Formatting helpers for the fees area.
 *
 * Money arrives as a decimal string (ADR-004) and is NEVER parsed into a float here. Display
 * formatting is pure string manipulation — split on the dot, group the integer part the way
 * numbers are read in Bangladesh (en-IN grouping: 12,34,567). The only arithmetic permitted in
 * the browser is integer minor units via BigInt, used solely to check that payment allocations
 * sum exactly to the payment amount — the same check `recordPaymentSchema` runs.
 */

/** Matches `positiveMoneySchema` from `@shikkha/validation` — used to guard BigInt parsing. */
const MONEY_SHAPE = /^\d{1,12}(\.\d{1,2})?$/;

export function isMoneyString(value: string): boolean {
  return MONEY_SHAPE.test(value);
}

/** Indian-system digit grouping: last three digits, then pairs. Pure string work. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(',')},${last3}`;
}

/** `"1234567.5"` → `"৳12,34,567.50"`. Never constructs a Number. */
export function formatMoney(value: string): string {
  const negative = value.startsWith('-');
  const raw = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = raw.split('.');
  const cents = `${fraction}00`.slice(0, 2);
  return `${negative ? '−' : ''}৳${groupIndian(whole)}.${cents}`;
}

/** A percentage stored as a two-decimal string (`"12.50"` = 12.5%). Display only. */
export function formatPercent(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}%` : `${whole}%`;
}

/** Dates arrive as calendar dates (`YYYY-MM-DD`), so they are formatted without a timezone. */
export function formatDate(value: string): string {
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}

/** Instants (ISO timestamps) are rendered explicitly in Dhaka local time. */
export function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dhaka',
  }).format(new Date(value));
}

/** Today as a `YYYY-MM-DD` calendar date in Asia/Dhaka — `en-CA` formats ISO-style. */
export function todayInDhaka(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
}

/**
 * A decimal money string as integer minor units (poisa). Callers must guard with
 * `isMoneyString` first; anything else returns 0n rather than throwing mid-keystroke.
 */
export function toMinor(value: string): bigint {
  if (!MONEY_SHAPE.test(value)) return 0n;
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0');
}

/** Integer minor units back to a two-decimal string for display. */
export function minorToDecimal(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${cents}`;
}
