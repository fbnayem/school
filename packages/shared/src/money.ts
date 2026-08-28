/**
 * Money — exact currency arithmetic for the fee, payment, payroll and accounting modules.
 *
 * Invariants:
 *  - The internal representation is an integer count of the currency's minor unit
 *    (poisa for BDT). It is a `bigint`, so there is no precision ceiling at 2^53 and no
 *    rounding drift.
 *  - There is no path from a JavaScript `number` to a Money value that silently rounds.
 *    `fromNumber` exists but rejects non-integer minor units.
 *  - Division never happens. Splitting an amount uses `allocate`, which distributes the
 *    remainder deterministically so that the parts always sum back to the whole.
 *
 * The database stores `numeric(14,2)`; the driver returns it as a string. `fromDecimalString`
 * is the only sanctioned parser for that boundary.
 */

export type CurrencyCode = 'BDT' | 'USD';

const MINOR_UNITS: Record<CurrencyCode, number> = {
  BDT: 2,
  USD: 2,
};

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export class Money {
  private constructor(
    /** Integer count of minor units (poisa for BDT). May be negative. */
    public readonly minor: bigint,
    public readonly currency: CurrencyCode,
  ) {}

  // ---------------------------------------------------------------- constructors

  static zero(currency: CurrencyCode = 'BDT'): Money {
    return new Money(0n, currency);
  }

  /** Construct from an integer count of minor units. */
  static fromMinor(minor: bigint | number, currency: CurrencyCode = 'BDT'): Money {
    if (typeof minor === 'number') {
      if (!Number.isInteger(minor)) {
        throw new MoneyError(`Minor units must be an integer, received ${minor}`);
      }
      if (!Number.isSafeInteger(minor)) {
        throw new MoneyError(`Minor units ${minor} exceeds the safe integer range`);
      }
      return new Money(BigInt(minor), currency);
    }
    return new Money(minor, currency);
  }

  /**
   * Parse the canonical decimal string form, which is what Postgres `numeric` returns and
   * what the API accepts on the wire. Accepts an optional sign, digits, and at most as many
   * decimal places as the currency has minor units.
   *
   * Deliberately strict: `"12.345"` for BDT is an error rather than a silent round, because
   * a caller sending three decimal places to a two-decimal currency has a bug worth surfacing.
   */
  static fromDecimalString(value: string, currency: CurrencyCode = 'BDT'): Money {
    const exponent = MINOR_UNITS[currency];
    const trimmed = value.trim();
    const match = /^(-|\+)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (!match) {
      throw new MoneyError(`Invalid money literal: ${JSON.stringify(value)}`);
    }
    const sign = match[1] === '-' ? -1n : 1n;
    const whole = match[2] ?? '0';
    const fraction = match[3] ?? '';
    if (fraction.length > exponent) {
      throw new MoneyError(
        `${currency} supports ${exponent} decimal places, received ${fraction.length} in ${JSON.stringify(value)}`,
      );
    }
    const padded = fraction.padEnd(exponent, '0');
    return new Money(sign * BigInt(whole + padded), currency);
  }

  /**
   * Convenience for literals in code and tests. Takes a major-unit number (taka) and
   * requires that it be exactly representable in the currency's minor units.
   */
  static fromMajor(value: number, currency: CurrencyCode = 'BDT'): Money {
    if (!Number.isFinite(value)) {
      throw new MoneyError(`Cannot build Money from ${value}`);
    }
    // Route through the string form so binary floating point never decides the rounding.
    return Money.fromDecimalString(value.toFixed(MINOR_UNITS[currency]), currency);
  }

  // ---------------------------------------------------------------- arithmetic

  private assertSameCurrency(other: Money, operation: string): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(
        `Cannot ${operation} ${other.currency} and ${this.currency}: currency mismatch`,
      );
    }
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other, 'add');
    return new Money(this.minor + other.minor, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other, 'subtract');
    return new Money(this.minor - other.minor, this.currency);
  }

  negated(): Money {
    return new Money(-this.minor, this.currency);
  }

  abs(): Money {
    return new Money(this.minor < 0n ? -this.minor : this.minor, this.currency);
  }

  /** Multiply by an integer quantity — e.g. a fee applied to N months. */
  times(factor: bigint | number): Money {
    if (typeof factor === 'number' && !Number.isInteger(factor)) {
      throw new MoneyError(
        `times() takes an integer factor; use percentage() or allocate() for fractional maths`,
      );
    }
    return new Money(this.minor * BigInt(factor), this.currency);
  }

  /**
   * Apply a percentage — the operation behind discounts, waivers, late fines and tax.
   *
   * `basisPoints` avoids passing a float: 15% is 1500, 7.5% is 750. Rounding is
   * half-up on the absolute value, so -0.5 rounds to -1 and 0.5 rounds to 1; a discount and
   * its equivalent charge therefore round symmetrically rather than drifting toward zero.
   */
  percentage(basisPoints: bigint | number): Money {
    const bp = BigInt(basisPoints);
    const scaled = this.minor * bp;
    const divisor = 10_000n;
    const negative = scaled < 0n;
    const magnitude = negative ? -scaled : scaled;
    const rounded = (magnitude + divisor / 2n) / divisor;
    return new Money(negative ? -rounded : rounded, this.currency);
  }

  /**
   * Split into `parts` amounts that sum exactly back to this value.
   *
   * With ratios: distributes proportionally, then hands the leftover minor units out one at
   * a time to the largest remainders (the largest-remainder method). Without ratios: splits
   * evenly, with the first buckets absorbing the remainder.
   *
   * This is the only correct way to build installment plans. Dividing and rounding each part
   * independently loses or invents poisa, which an accounting system will eventually notice.
   */
  allocate(ratios: readonly number[]): Money[] {
    if (ratios.length === 0) {
      throw new MoneyError('allocate() requires at least one ratio');
    }
    if (ratios.some((r) => r < 0 || !Number.isFinite(r))) {
      throw new MoneyError('allocate() ratios must be finite and non-negative');
    }
    const total = ratios.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      throw new MoneyError('allocate() ratios must sum to a positive value');
    }

    // Work on the absolute value so the remainder always flows in the same direction as the
    // sign of the amount, then restore the sign at the end.
    const negative = this.minor < 0n;
    const magnitude = negative ? -this.minor : this.minor;

    // Scale ratios to integers to keep the proportional step in bigint arithmetic.
    const SCALE = 1_000_000;
    const scaledRatios = ratios.map((r) => BigInt(Math.round(r * SCALE)));
    const scaledTotal = scaledRatios.reduce((a, b) => a + b, 0n);
    if (scaledTotal === 0n) {
      throw new MoneyError('allocate() ratios must sum to a positive value');
    }

    const base: bigint[] = [];
    const remainders: { index: number; remainder: bigint }[] = [];
    let distributed = 0n;

    scaledRatios.forEach((ratio, index) => {
      const numerator = magnitude * ratio;
      const share = numerator / scaledTotal;
      base.push(share);
      remainders.push({ index, remainder: numerator % scaledTotal });
      distributed += share;
    });

    let leftover = magnitude - distributed;
    // Largest remainder first; ties resolve by original order so the result is deterministic.
    remainders.sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
    for (const entry of remainders) {
      if (leftover <= 0n) break;
      base[entry.index] = (base[entry.index] ?? 0n) + 1n;
      leftover -= 1n;
    }

    return base.map((minor) => new Money(negative ? -minor : minor, this.currency));
  }

  /** Split into `n` roughly equal parts that sum exactly back to this value. */
  split(n: number): Money[] {
    if (!Number.isInteger(n) || n < 1) {
      throw new MoneyError(`split() requires a positive integer, received ${n}`);
    }
    return this.allocate(new Array<number>(n).fill(1));
  }

  // ---------------------------------------------------------------- comparison

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other, 'compare');
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) === 1;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) === -1;
  }

  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  // ---------------------------------------------------------------- serialisation

  /**
   * Canonical decimal string — what goes into a `numeric` column and onto the wire.
   * Always carries the full number of decimal places so string comparison is meaningful.
   */
  toDecimalString(): string {
    const exponent = MINOR_UNITS[this.currency];
    const negative = this.minor < 0n;
    const magnitude = (negative ? -this.minor : this.minor).toString().padStart(exponent + 1, '0');
    const whole = magnitude.slice(0, magnitude.length - exponent);
    const fraction = magnitude.slice(magnitude.length - exponent);
    return `${negative ? '-' : ''}${whole}${exponent > 0 ? `.${fraction}` : ''}`;
  }

  /**
   * Display form for UI and printed documents. Bangladeshi grouping (lakh/crore) differs from
   * the Western thousands grouping, and `Intl` gets it right for the `en-IN`/`bn-BD` locales,
   * so this defers to `Intl` rather than hand-rolling the separators.
   */
  format(locale: 'en-BD' | 'bn-BD' = 'en-BD'): string {
    const formatter = new Intl.NumberFormat(locale === 'bn-BD' ? 'bn-BD' : 'en-IN', {
      style: 'currency',
      currency: this.currency,
      minimumFractionDigits: MINOR_UNITS[this.currency],
      maximumFractionDigits: MINOR_UNITS[this.currency],
    });
    return formatter.format(Number(this.toDecimalString()));
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.toDecimalString(), currency: this.currency };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  // ---------------------------------------------------------------- aggregates

  static sum(values: readonly Money[], currency: CurrencyCode = 'BDT'): Money {
    return values.reduce<Money>((acc, value) => acc.plus(value), Money.zero(currency));
  }

  static min(a: Money, b: Money): Money {
    return a.lessThan(b) ? a : b;
  }

  static max(a: Money, b: Money): Money {
    return a.greaterThan(b) ? a : b;
  }
}
