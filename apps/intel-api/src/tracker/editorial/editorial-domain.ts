import { createHash } from 'node:crypto';
/** PostgreSQL jsonb does not retain object key order. Array order remains meaningful. */
export function canonicalEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEvidence);
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalEvidence(v)]),
    );
  return value;
}
export const evidenceDigest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalEvidence(value)))
    .digest('hex');
