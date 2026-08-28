/**
 * Isomorphic byte and encoding helpers.
 *
 * `@shikkha/shared` is imported by the API (Node) *and* by the web app (browser bundle), so it
 * must not reach for `node:crypto` or `Buffer`. Both exist in Node and neither exists in a
 * browser, and webpack does not shim `node:`-prefixed imports — the build simply fails.
 *
 * Everything here uses the Web Crypto API and `TextEncoder`/`TextDecoder`, which are standard
 * in browsers and have been global in Node since v18. One implementation, both runtimes, no
 * conditional exports to keep in sync.
 */

/**
 * Cryptographically secure random bytes.
 *
 * `crypto.getRandomValues` caps at 65536 bytes per call, so larger requests are filled in
 * chunks. Nothing here asks for more than 32, but a helper that silently truncates is the kind
 * of thing that becomes a vulnerability the first time someone reuses it.
 */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new Error(`randomBytes expects a non-negative integer, received ${length}`);
  }
  const out = new Uint8Array(length);
  const MAX_CHUNK = 65_536;
  for (let offset = 0; offset < length; offset += MAX_CHUNK) {
    const chunk = out.subarray(offset, Math.min(offset + MAX_CHUNK, length));
    globalThis.crypto.getRandomValues(chunk);
  }
  return out;
}

/**
 * A uniformly distributed integer in `[min, max]`.
 *
 * Rejection sampling rather than modulo: `randomByte % n` over-represents the low values
 * whenever `n` does not divide 256, and for something like an invitation code that bias is a
 * real reduction in entropy.
 */
export function randomInt(min: number, max: number): number {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
    throw new Error(`randomInt expects integers with max >= min, received ${min}..${max}`);
  }
  const range = max - min + 1;
  if (range === 1) return min;

  // Enough bytes to cover the range, with a ceiling that makes the rejection cheap.
  const bytesNeeded = Math.ceil(Math.log2(range) / 8);
  const maxValue = 256 ** bytesNeeded;
  const limit = maxValue - (maxValue % range);

  for (;;) {
    const bytes = randomBytes(bytesNeeded);
    let value = 0;
    for (const byte of bytes) value = value * 256 + byte;
    if (value < limit) return min + (value % range);
  }
}

const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
  }
  return out;
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url, without padding — the form used in URLs, JWTs and opaque tokens. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += BASE64URL_ALPHABET[b0 >> 2]!;
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

export function fromBase64Url(value: string): Uint8Array {
  const lookup = new Map<string, number>();
  for (let i = 0; i < BASE64URL_ALPHABET.length; i += 1) {
    lookup.set(BASE64URL_ALPHABET[i]!, i);
  }

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of value) {
    const index = lookup.get(char);
    if (index === undefined) {
      throw new Error('Invalid base64url input');
    }
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return Uint8Array.from(bytes);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeUtf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** UTF-8 string to base64url, for opaque cursors and short encoded payloads. */
export function stringToBase64Url(value: string): string {
  return toBase64Url(encodeUtf8(value));
}

export function base64UrlToString(value: string): string {
  return decodeUtf8(fromBase64Url(value));
}
