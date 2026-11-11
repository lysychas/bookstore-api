import { createHash, timingSafeEqual } from 'node:crypto';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time string comparison.
 *
 * Both inputs are hashed with SHA-256 first so the buffers handed to
 * `timingSafeEqual` always have the same length (32 bytes). This avoids the
 * length-mismatch throw and does not leak the secret's length via timing.
 * Non-string inputs never match.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(sha256(a), sha256(b));
}
