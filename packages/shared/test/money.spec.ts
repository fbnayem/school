import { describe, expect, it } from 'vitest';
import { Money, MoneyError } from '../src/money';

describe('Money construction', () => {
  it('parses the canonical decimal string form returned by Postgres numeric', () => {
    expect(Money.fromDecimalString('1500.00').minor).toBe(150_000n);
    expect(Money.fromDecimalString('0.05').minor).toBe(5n);
    expect(Money.fromDecimalString('-250.75').minor).toBe(-25_075n);
    expect(Money.fromDecimalString('+12.30').minor).toBe(1230n);
  });

  it('accepts fewer decimal places than the currency supports', () => {
    expect(Money.fromDecimalString('1500').toDecimalString()).toBe('1500.00');
    expect(Money.fromDecimalString('1500.5').toDecimalString()).toBe('1500.50');
  });

  it('rejects more precision than the currency has, rather than rounding silently', () => {
    expect(() => Money.fromDecimalString('12.345')).toThrow(MoneyError);
  });

  it('rejects malformed literals', () => {
    for (const bad of ['', 'abc', '12.', '1,500.00', '১২.৩৪', '12.3.4', 'NaN']) {
      expect(() => Money.fromDecimalString(bad), bad).toThrow(MoneyError);
    }
  });

  it('rejects non-integer minor units', () => {
    expect(() => Money.fromMinor(10.5)).toThrow(MoneyError);
  });

  it('routes fromMajor through the string form so binary float never sets the value', () => {
    // 0.1 + 0.2 style representation error must not reach the ledger.
    expect(Money.fromMajor(1234.56).minor).toBe(123_456n);
    expect(Money.fromMajor(0.29).minor).toBe(29n);
    expect(Money.fromMajor(8.7).minor).toBe(870n);
  });

  it('handles values beyond the safe integer range in major units', () => {
    const large = Money.fromDecimalString('99999999999.99');
    expect(large.toDecimalString()).toBe('99999999999.99');
    expect(large.plus(Money.fromDecimalString('0.01')).toDecimalString()).toBe('100000000000.00');
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    const a = Money.fromDecimalString('1500.50');
    const b = Money.fromDecimalString('249.75');
    expect(a.plus(b).toDecimalString()).toBe('1750.25');
    expect(a.minus(b).toDecimalString()).toBe('1250.75');
  });

  it('accumulates repeated additions without drift', () => {
    // The float equivalent of this loop lands on 0.30000000000000004.
    let total = Money.zero();
    for (let i = 0; i < 3; i += 1) total = total.plus(Money.fromDecimalString('0.10'));
    expect(total.toDecimalString()).toBe('0.30');

    let tuition = Money.zero();
    for (let i = 0; i < 1000; i += 1) tuition = tuition.plus(Money.fromDecimalString('1234.57'));
    expect(tuition.toDecimalString()).toBe('1234570.00');
  });

  it('refuses to mix currencies', () => {
    const bdt = Money.fromDecimalString('100.00', 'BDT');
    const usd = Money.fromDecimalString('100.00', 'USD');
    expect(() => bdt.plus(usd)).toThrow(/currency mismatch/i);
    expect(() => bdt.compare(usd)).toThrow(/currency mismatch/i);
  });

  it('multiplies by integer quantities only', () => {
    expect(Money.fromDecimalString('500.00').times(12).toDecimalString()).toBe('6000.00');
    expect(() => Money.fromDecimalString('500.00').times(1.5)).toThrow(MoneyError);
  });

  it('applies percentages in basis points with half-up rounding', () => {
    expect(Money.fromDecimalString('1000.00').percentage(1500).toDecimalString()).toBe('150.00');
    expect(Money.fromDecimalString('333.33').percentage(750).toDecimalString()).toBe('25.00');
    // 0.005 exactly: rounds away from zero, symmetrically for charge and discount.
    expect(Money.fromDecimalString('1.00').percentage(50).toDecimalString()).toBe('0.01');
    expect(Money.fromDecimalString('-1.00').percentage(50).toDecimalString()).toBe('-0.01');
  });

  it('sums an empty list to zero', () => {
    expect(Money.sum([]).isZero()).toBe(true);
  });
});

describe('Money.allocate — the installment invariant', () => {
  it('splits evenly when the amount divides cleanly', () => {
    const parts = Money.fromDecimalString('900.00').split(3);
    expect(parts.map((p) => p.toDecimalString())).toEqual(['300.00', '300.00', '300.00']);
  });

  it('never loses or invents minor units on an uneven split', () => {
    const total = Money.fromDecimalString('100.00');
    const parts = total.split(3);
    expect(parts.map((p) => p.toDecimalString())).toEqual(['33.34', '33.33', '33.33']);
    expect(Money.sum(parts).equals(total)).toBe(true);
  });

  it('preserves the total for every split size up to 24 installments', () => {
    const total = Money.fromDecimalString('12345.67');
    for (let n = 1; n <= 24; n += 1) {
      const parts = total.split(n);
      expect(parts).toHaveLength(n);
      expect(Money.sum(parts).toDecimalString(), `split into ${n}`).toBe(total.toDecimalString());
    }
  });

  it('distributes proportionally by the largest-remainder method', () => {
    // A 1000 taka discount spread across line items of 3:2:1.
    const parts = Money.fromDecimalString('1000.00').allocate([3, 2, 1]);
    // 3:2:1 of 100000 poisa gives base shares 50000 / 33333 / 16666 with 1 poisa left over.
    // The third bucket has the largest remainder, so it takes the extra unit.
    expect(parts.map((p) => p.toDecimalString())).toEqual(['500.00', '333.33', '166.67']);
    expect(Money.sum(parts).toDecimalString()).toBe('1000.00');
  });

  it('keeps the sign and the total for negative amounts (refunds and credit notes)', () => {
    const credit = Money.fromDecimalString('-100.00');
    const parts = credit.split(3);
    expect(parts.every((p) => p.isNegative())).toBe(true);
    expect(Money.sum(parts).toDecimalString()).toBe('-100.00');
  });

  it('handles zero-weight buckets without dropping the remainder', () => {
    const parts = Money.fromDecimalString('100.00').allocate([1, 0, 1]);
    expect(parts.map((p) => p.toDecimalString())).toEqual(['50.00', '0.00', '50.00']);
    expect(Money.sum(parts).toDecimalString()).toBe('100.00');
  });

  it('is deterministic — ties resolve by position, not by chance', () => {
    const first = Money.fromDecimalString('10.00').allocate([1, 1, 1]);
    const second = Money.fromDecimalString('10.00').allocate([1, 1, 1]);
    expect(first.map((p) => p.toDecimalString())).toEqual(second.map((p) => p.toDecimalString()));
  });

  it('rejects nonsensical ratios', () => {
    expect(() => Money.fromDecimalString('10.00').allocate([])).toThrow(MoneyError);
    expect(() => Money.fromDecimalString('10.00').allocate([0, 0])).toThrow(MoneyError);
    expect(() => Money.fromDecimalString('10.00').allocate([-1, 2])).toThrow(MoneyError);
    expect(() => Money.fromDecimalString('10.00').split(0)).toThrow(MoneyError);
    expect(() => Money.fromDecimalString('10.00').split(2.5)).toThrow(MoneyError);
  });
});

describe('Money serialisation', () => {
  it('round-trips through the database string form', () => {
    for (const literal of ['0.00', '1.00', '-1.00', '0.01', '123456.78', '-0.99']) {
      expect(Money.fromDecimalString(literal).toDecimalString()).toBe(literal);
    }
  });

  it('always pads to the currency precision so string comparison is meaningful', () => {
    expect(Money.fromMinor(5n).toDecimalString()).toBe('0.05');
    expect(Money.fromMinor(0n).toDecimalString()).toBe('0.00');
    expect(Money.fromMinor(-5n).toDecimalString()).toBe('-0.05');
  });

  it('serialises to a JSON envelope carrying the currency', () => {
    expect(Money.fromDecimalString('42.50').toJSON()).toEqual({
      amount: '42.50',
      currency: 'BDT',
    });
  });

  it('formats with Bangladeshi lakh/crore grouping', () => {
    // en-IN grouping: 12,34,567.00 rather than 1,234,567.00
    const formatted = Money.fromDecimalString('1234567.00').format('en-BD');
    expect(formatted).toContain('12,34,567');
  });
});

describe('Money comparison', () => {
  it('orders and compares within a currency', () => {
    const small = Money.fromDecimalString('10.00');
    const large = Money.fromDecimalString('20.00');
    expect(small.lessThan(large)).toBe(true);
    expect(large.greaterThan(small)).toBe(true);
    expect(small.equals(Money.fromDecimalString('10.00'))).toBe(true);
    expect(small.greaterThanOrEqual(small)).toBe(true);
    expect(Money.min(small, large).equals(small)).toBe(true);
    expect(Money.max(small, large).equals(large)).toBe(true);
  });

  it('treats different currencies with the same minor value as unequal', () => {
    expect(
      Money.fromDecimalString('10.00', 'BDT').equals(Money.fromDecimalString('10.00', 'USD')),
    ).toBe(false);
  });
});
