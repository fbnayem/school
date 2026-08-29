/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), implemented directly on `node:crypto`.
 *
 * Thirty lines of standardised HMAC arithmetic did not justify a dependency: the entire
 * algorithm is HMAC-SHA1 over a big-endian counter, dynamic truncation, modulo 10^6. The
 * parameters are the ones every authenticator app (Google Authenticator, Authy, Aegis,
 * FreeOTP) assumes by default — SHA-1, 6 digits, 30-second step — and they are fixed here
 * rather than configurable, because a school that could misconfigure its OTP hash would
 * simply lock all of its staff out.
 *
 * Replay protection is NOT in this file on purpose: it needs the database (the user's
 * highest verified step), so it lives in `MfaService`. This file answers only "does this
 * code match this secret at this time", and returns the *matched step* so the caller can
 * enforce monotonicity.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/** Accept the previous and next step, so ±30s of clock skew does not lock users out. */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — the alphabet authenticator apps expect in the URI. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character in TOTP secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits of secret, matching the HMAC-SHA1 block the RFC recommends. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The current TOTP time step for a moment in time. */
export function totpStep(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** RFC 4226 §5.3: HMAC-SHA1, dynamic truncation, modulo 10^digits, zero-padded. */
export function hotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Verify a code within ±TOTP_WINDOW steps of `at`.
 *
 * Returns the step the code matched, or null. Comparison is constant-time per candidate;
 * the caller must additionally require the returned step to be strictly greater than the
 * user's last verified step, or an observed code is replayable for up to 90 seconds.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  at: Date = new Date(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(at);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    const expected = hotp(secretBase32, step);
    if (constantTimeEqualDigits(expected, code)) return step;
  }
  return null;
}

/**
 * The otpauth:// URI that becomes the QR code. The label is `issuer:account` so the entry
 * in the authenticator app is recognisable among a family's several school accounts.
 */
export function buildOtpauthUri(secretBase32: string, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function constantTimeEqualDigits(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
