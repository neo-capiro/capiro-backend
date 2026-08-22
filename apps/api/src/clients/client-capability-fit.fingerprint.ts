/**
 * Fingerprint of the capability signals that feed the capability-fit projection.
 *
 * The cache is not auto-invalidated on every read (recomputing means a PE fan-out
 * that can take ~30s), so the fit card needs a cheap way to tell the user "these
 * results predate your latest capability edits". Hashing exactly the fields the
 * upstream scorers consume means an edit that CANNOT change the outcome (say, a
 * capability's notes) does not needlessly mark the cache stale.
 *
 * PURE module: no DB, no NestJS, no I/O.
 */

import { createHash } from 'node:crypto';

/** A capability row reduced to the fields that can change a match. */
export interface CapabilityFingerprintInput {
  id: string;
  name?: string | null;
  /** `tags_jsonb` — string[] in practice, but typed loose because it is JSON. */
  tags?: unknown;
  keywords?: string[] | null;
  peNumbers?: string[] | null;
  peNumber?: string | null;
  sector?: string | null;
  updatedAt?: string | Date | null;
}

/** Coerce the JSON `tags` column to a sorted, trimmed string list. */
function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function normalizeList(values: string[] | null | undefined): string[] {
  return (values ?? [])
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function normalizeTimestamp(value: string | Date | null | undefined): string {
  if (!value) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * sha256 hex of the client's capability signal surface. Order-insensitive across
 * capabilities (sorted by id) so a re-ordered query result is not "a change".
 */
export function capabilityFitFingerprint(input: {
  capabilities: CapabilityFingerprintInput[];
  issueCodes?: string[];
}): string {
  const caps = [...input.capabilities]
    .map((cap) => ({
      id: cap.id,
      name: (cap.name ?? '').trim().toLowerCase(),
      tags: normalizeTags(cap.tags),
      keywords: normalizeList(cap.keywords),
      peNumbers: normalizeList([...(cap.peNumbers ?? []), cap.peNumber ?? '']),
      sector: (cap.sector ?? '').trim().toLowerCase(),
      updatedAt: normalizeTimestamp(cap.updatedAt),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const payload = JSON.stringify({
    capabilities: caps,
    issueCodes: normalizeList(input.issueCodes),
  });

  return createHash('sha256').update(payload).digest('hex');
}
