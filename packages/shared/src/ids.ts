/**
 * Identifier generation.
 *
 * Primary keys are UUIDv7. Unlike UUIDv4 they are time-ordered, which keeps B-tree index
 * inserts sequential instead of scattering writes across the whole index — a real difference
 * once a tenant has millions of attendance rows. Unlike a bigserial they do not leak row
 * counts or allow enumeration of another tenant's records by guessing adjacent integers.
 *
 * No runtime exposes `randomUUID({ version: 7 })` yet, so v7 is composed here from the Web
 * Crypto API following RFC 9562 §5.7. Web Crypto rather than `node:crypto` because this module
 * is bundled into the browser as well as run on the server — see `bytes.ts`.
 */

import { randomBytes, randomInt, toBase64Url, toHex } from './bytes';

export type Uuid = string;

let lastTimestampMs = 0;
let sequenceCounter = 0;

/**
 * RFC 9562 UUIDv7: 48-bit big-endian Unix milliseconds, 4-bit version, 12 bits of
 * monotonic counter, 2-bit variant, 62 bits of randomness.
 *
 * The counter guarantees ordering for IDs generated within the same millisecond, which
 * matters for bulk inserts — attendance for a 60-student section is written in one tick.
 */
export function uuidv7(now: number = Date.now()): Uuid {
  if (now === lastTimestampMs) {
    sequenceCounter = (sequenceCounter + 1) & 0x0fff;
    // Counter exhausted within one millisecond: borrow from the next millisecond rather
    // than emitting a duplicate. 4096 IDs/ms is well beyond realistic write volume.
    if (sequenceCounter === 0) {
      lastTimestampMs = now + 1;
      now = lastTimestampMs;
    }
  } else if (now > lastTimestampMs) {
    lastTimestampMs = now;
    sequenceCounter = randomInt(0, 0x0100); // Start low so there is counter headroom.
  } else {
    // Clock moved backwards (NTP correction). Keep monotonicity rather than trusting the clock.
    now = lastTimestampMs;
    sequenceCounter = (sequenceCounter + 1) & 0x0fff;
  }

  const bytes = randomBytes(16);
  const timestamp = BigInt(now);

  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);

  bytes[6] = 0x70 | ((sequenceCounter >> 8) & 0x0f); // version 7 + counter high nibble
  bytes[7] = sequenceCounter & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f); // variant 10xx

  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Extract the embedded timestamp from a v7 UUID. Returns null for other versions. */
export function uuidv7Timestamp(id: Uuid): Date | null {
  if (!isUuid(id) || id[14] !== '7') return null;
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(Number(BigInt(`0x${hex}`)));
}

/**
 * An unambiguous alphabet for human-facing codes. These get read aloud over the phone and
 * copied off printed receipts, so one side of each confusable pair is dropped: 0 and O,
 * 1 with I and L, S (keeping 5), and B (keeping 8).
 */
const HUMAN_ALPHABET = '23456789ACDEFGHJKMNPQRTUVWXYZ';

export function humanCode(length = 8): string {
  // 29 is not a power of two, so `byte % 29` would over-represent the first few characters.
  // Rejection sampling costs a few extra bytes and keeps the distribution uniform.
  const size = HUMAN_ALPHABET.length;
  const limit = 256 - (256 % size);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += HUMAN_ALPHABET[byte % size];
      if (out.length === length) break;
    }
  }
  return out;
}

/** URL-safe high-entropy secret for refresh tokens, invitations and password resets. */
export function secureToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

/**
 * Build a zero-padded sequential reference such as `INV-2026-000042`.
 * The caller supplies the sequence value; this only formats it, so the uniqueness guarantee
 * stays where it belongs — in a database sequence or a transactional counter row.
 */
export function formatReference(prefix: string, year: number, sequence: number, width = 6): string {
  return `${prefix}-${year}-${String(sequence).padStart(width, '0')}`;
}
