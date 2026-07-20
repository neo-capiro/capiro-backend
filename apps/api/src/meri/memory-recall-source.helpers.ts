/**
 * Per-tenant resolution of the Meri memory-recall backing (Phase 1 SSOT cutover).
 * 'clio' = pre-cutover (OpenAI-embedding recall over clio_memory); 'union' = clio
 * ∪ the Titan-embedded memory_items projection (a provable superset that removes
 * the OpenAI-recall single-point-of-failure); 'projection' = projection-first.
 *
 * A per-tenant settings_jsonb.clioFeatureFlags.meriMemoryRecallSource override
 * wins over the global MEMORY_RECALL_SOURCE env, so 'union' can be canaried on one
 * tenant before a fleet-wide flip. Pure (no I/O) so it is unit-testable in
 * isolation from MeriService — mirrors @capiro/meriv2-core's resolveAuditorMode.
 */
export type MemoryRecallSource = 'clio' | 'union' | 'projection';

const VALID: ReadonlySet<string> = new Set(['clio', 'union', 'projection']);

/**
 * The per-tenant override (settings_jsonb.clioFeatureFlags.meriMemoryRecallSource)
 * wins when it is one of the three valid values; anything absent/invalid falls
 * back to the global `envMode`.
 */
export function pickMemoryRecallSource(
  envMode: MemoryRecallSource,
  settings: unknown,
): MemoryRecallSource {
  const flags = (settings as { clioFeatureFlags?: Record<string, unknown> } | null | undefined)
    ?.clioFeatureFlags;
  const override = flags?.meriMemoryRecallSource;
  if (typeof override === 'string' && VALID.has(override)) return override as MemoryRecallSource;
  return envMode;
}

/**
 * Phase 5 — per-tenant resolution of the unified recall reranker (recency +
 * confidence fusion). Mirrors pickMemoryRecallSource: a
 * settings_jsonb.clioFeatureFlags.meriRecallRerank of 'on'/'off' wins over the
 * global MERI_RECALL_RERANK env, so rerank can be canaried on one tenant
 * (capiro-internal) before a fleet flip. Pure; unit-tested with pickMemoryRecallSource.
 */
export function pickRecallRerank(envOn: boolean, settings: unknown): boolean {
  const flags = (settings as { clioFeatureFlags?: Record<string, unknown> } | null | undefined)
    ?.clioFeatureFlags;
  const override = flags?.meriRecallRerank;
  if (override === 'on' || override === true) return true;
  if (override === 'off' || override === false) return false;
  return envOn;
}

/**
 * Post-filter a scored recall result set to rows at/above the relevance floor
 * (MEMORY_PROJECTION_MIN_SCORE for the projection path). Runs AFTER the vector
 * `ORDER BY … LIMIT`, so it can only suppress weak tail matches — it never
 * changes which rows are top-K, mirroring how the clio path applies its 0.3
 * floor after LIMIT. `minScore <= 0` (or non-finite) disables the floor.
 */
export function applyRecallScoreFloor<T extends { score: number }>(
  rows: T[],
  minScore: number,
): T[] {
  if (!Number.isFinite(minScore) || minScore <= 0) return rows;
  return rows.filter((r) => typeof r.score === 'number' && r.score >= minScore);
}
