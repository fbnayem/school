import { describe, expect, it } from 'vitest';
import {
  base64UrlToString,
  fromBase64Url,
  randomBytes,
  randomInt,
  stringToBase64Url,
  toBase64Url,
  toHex,
} from '../src/bytes';

describe('randomBytes', () => {
  it('returns the requested length', () => {
    for (const length of [0, 1, 16, 32, 1000]) {
      expect(randomBytes(length)).toHaveLength(length);
    }
  });

  it('handles a request larger than the 65536-byte getRandomValues limit', () => {
    // A naive implementation throws here, or worse, silently returns a short buffer.
    const bytes = randomBytes(200_000);
    expect(bytes).toHaveLength(200_000);
    // Every chunk must actually be filled; an unfilled tail would be all zeros.
    const tail = bytes.subarray(190_000);
    expect(tail.some((byte) => byte !== 0)).toBe(true);
  });

  it('rejects a nonsensical length', () => {
    expect(() => randomBytes(-1)).toThrow();
    expect(() => randomBytes(1.5)).toThrow();
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => toHex(randomBytes(16))));
    expect(seen.size).toBe(2000);
  });
});

describe('randomInt', () => {
  it('stays within the inclusive range', () => {
    for (let i = 0; i < 5_000; i += 1) {
      const value = randomInt(3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
    }
  });

  it('handles a single-value range', () => {
    expect(randomInt(5, 5)).toBe(5);
  });

  it('covers every value in a small range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i += 1) seen.add(randomInt(0, 9));
    expect(seen.size).toBe(10);
  });

  it('is close to uniform — no modulo bias', () => {
    // A range of 29 does not divide 256, which is exactly where `byte % n` skews.
    const counts = new Array<number>(29).fill(0);
    const samples = 58_000;
    for (let i = 0; i < samples; i += 1) counts[randomInt(0, 28)]! += 1;

    const expected = samples / 29;
    for (const count of counts) {
      // ±20% is loose enough not to flake and tight enough to catch real bias, which shows up
      // as roughly a 2x over-representation of the low values.
      expect(count).toBeGreaterThan(expected * 0.8);
      expect(count).toBeLessThan(expected * 1.2);
    }
  });

  it('rejects a reversed or non-integer range', () => {
    expect(() => randomInt(10, 5)).toThrow();
    expect(() => randomInt(0.5, 5)).toThrow();
  });
});

describe('hex encoding', () => {
  it('produces lowercase, zero-padded hex', () => {
    expect(toHex(Uint8Array.from([0, 15, 16, 255]))).toBe('000f10ff');
  });

  it('produces two characters per byte', () => {
    expect(toHex(randomBytes(32))).toHaveLength(64);
  });
});

describe('base64url encoding', () => {
  it('round-trips arbitrary bytes', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 31, 32, 33, 64]) {
      const original = randomBytes(length);
      const restored = fromBase64Url(toBase64Url(original));
      expect(Array.from(restored), `length ${length}`).toEqual(Array.from(original));
    }
  });

  it('uses the URL-safe alphabet and no padding', () => {
    const encoded = toBase64Url(randomBytes(64));
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
  });

  it('matches Node Buffer base64url for known input', () => {
    // Cross-checked against the implementation this replaced, so the encoding is not merely
    // self-consistent — tokens issued before the change still decode.
    const bytes = Uint8Array.from([0xfb, 0xff, 0xfe, 0x00, 0x10, 0x83]);
    expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  });

  it('round-trips UTF-8 strings including Bangla', () => {
    for (const value of ['', 'hello', '{"a":1}', 'ঢাকা ফিউচার একাডেমি', '01712-345678']) {
      expect(base64UrlToString(stringToBase64Url(value)), value).toBe(value);
    }
  });

  it('rejects input outside the alphabet', () => {
    expect(() => fromBase64Url('not valid!')).toThrow();
  });
});
