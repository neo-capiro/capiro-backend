import { createHash, timingSafeEqual } from 'node:crypto';

/** The existing backend-only service credential. It never supplies user scope. */
export function internalServiceSecretMatches(provided: unknown, expected: unknown): boolean {
  if (typeof expected !== 'string' || expected.length === 0 || typeof provided !== 'string') return false;
  return timingSafeEqual(
    createHash('sha256').update(provided, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest(),
  );
}
