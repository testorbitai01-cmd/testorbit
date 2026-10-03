import crypto from 'node:crypto';
import { env } from '../config/env.js';

/** 256-bit random, URL-safe session token (sent to the browser in an HTTP-only cookie). */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Tokens and codes are stored only as keyed hashes so a database leak does not expose live sessions. */
export function hashToken(token: string): string {
  return crypto.createHmac('sha256', env.SESSION_SECRET).update(token).digest('hex');
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Unambiguous alphabet (no 0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 8-character single-use resume code (~39 bits), shown once to the approving admin. */
export function generateResumeCode(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Unbiased Fisher–Yates shuffle using a CSPRNG. Returns a new array. */
export function secureShuffle<T>(items: readonly T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
