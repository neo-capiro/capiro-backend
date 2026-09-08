import { createHash } from 'node:crypto';

/**
 * Canonical sync-key derivation for Tango subaward walks, shared by the
 * ingestion script (which writes checkpoints) and the District Nexus supplier
 * status reader (which derives corpus completeness from them).
 *
 * The key covers ONLY the filters that change the provider-side result set
 * (fiscal year, prime UEI, subawardee UEI, local state filter). Page size and
 * limit are deliberately NOT part of the key: they are pagination mechanics of
 * ONE walk, not filters that partition the corpus. A filtered run (e.g. a
 * single fiscal year) produces a DIFFERENT key than the unfiltered walk and
 * must never be read as evidence of global corpus completeness.
 */
export interface SubawardSyncFilterFingerprint {
  fiscalYear: number | null;
  primeUei: string | null;
  subawardeeUei: string | null;
  state: string | null;
}

export function subawardSyncKeyFor(filters: SubawardSyncFilterFingerprint): string {
  const stableFilters = JSON.stringify({
    fiscalYear: filters.fiscalYear ?? null,
    primeUei: filters.primeUei ?? null,
    subawardeeUei: filters.subawardeeUei ?? null,
    state: filters.state ?? null,
  });
  return `subawards:${createHash('sha256').update(stableFilters).digest('hex').slice(0, 32)}`;
}

/**
 * The sync key of the UNFILTERED whole-corpus walk (no fiscal year, no UEI,
 * no state filter). This is the only walk whose checkpoint can speak to
 * global corpus completeness; filtered runs say nothing about it.
 */
export const UNFILTERED_SUBAWARD_SYNC_KEY = subawardSyncKeyFor({
  fiscalYear: null,
  primeUei: null,
  subawardeeUei: null,
  state: null,
});
