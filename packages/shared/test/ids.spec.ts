import { describe, expect, it } from 'vitest';
import {
  formatReference,
  humanCode,
  isUuid,
  secureToken,
  uuidv7,
  uuidv7Timestamp,
} from '../src/ids';

describe('uuidv7', () => {
  it('produces well-formed version 7 UUIDs', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('is unique across a large burst', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) ids.add(uuidv7());
    expect(ids.size).toBe(20_000);
  });

  it('sorts lexically in creation order, which is what keeps index inserts sequential', () => {
    const ids: string[] = [];
    for (let i = 0; i < 5_000; i += 1) ids.push(uuidv7());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('embeds a recoverable millisecond timestamp', () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    const extracted = uuidv7Timestamp(id);
    expect(extracted).not.toBeNull();
    expect(extracted!.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(extracted!.getTime()).toBeLessThanOrEqual(after + 1);
  });

  it('stays monotonic when the clock jumps backwards', () => {
    const forward = uuidv7(Date.now());
    const backward = uuidv7(Date.now() - 60_000);
    expect(backward > forward).toBe(true);
  });

  it('returns null when asked for the timestamp of a non-v7 UUID', () => {
    expect(uuidv7Timestamp('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(uuidv7Timestamp('not-a-uuid')).toBeNull();
  });
});

describe('humanCode', () => {
  it('avoids characters that are misread when spoken or printed', () => {
    const sample = Array.from({ length: 500 }, () => humanCode(12)).join('');
    expect(sample).not.toMatch(/[01OILSB]/);
  });

  it('respects the requested length', () => {
    expect(humanCode(6)).toHaveLength(6);
    expect(humanCode(16)).toHaveLength(16);
  });
});

describe('secureToken', () => {
  it('is URL-safe and high entropy', () => {
    const token = secureToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 5_000 }, () => secureToken()));
    expect(tokens.size).toBe(5_000);
  });
});

describe('formatReference', () => {
  it('zero-pads a sequence into a readable document number', () => {
    expect(formatReference('INV', 2026, 42)).toBe('INV-2026-000042');
    expect(formatReference('RCP', 2026, 1, 4)).toBe('RCP-2026-0001');
  });

  it('does not truncate a sequence that outgrows the padding width', () => {
    expect(formatReference('INV', 2026, 1_234_567)).toBe('INV-2026-1234567');
  });
});
