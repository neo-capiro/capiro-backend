/**
 * Phase 5 — unified recall scoring (pure, no I/O; unit-testable like
 * memory-recall-source.helpers.ts). Fuses embedding similarity with recency
 * decay and Phase-4 confidence into ONE score, so recall can prefer a fresh,
 * confident memory over a stale, uncertain one WITHOUT ever fabricating a
 * boost (fused ≤ similarity always).
 *
 * This SUBSUMES Phase 4's confidence-only rerank (rerankByConfidence): confidence
 * enters here as one weighted factor, reusing confidenceFactor's clamp. When
 * rerank is off the caller keeps today's pure-cosine order (byte-identical).
 *
 * fused = similarity × (wSim + wRec·recencyFactor + wConf·confidenceFactor)
 *   recencyFactor = 2^(-ageDays / halfLifeDays) ∈ (0,1]; missing age ⇒ 1 (fail-open)
 *   confidenceFactor ∈ (0,1]; missing confidence ⇒ neutral (default 0.75)
 *   weights sum to 1 (defaults 0.60/0.25/0.15) ⇒ fresh+confident ⇒ fused ≈ similarity.
 */

const DEFAULT_WEIGHTS = { sim: 0.6, rec: 0.25, conf: 0.15 } as const;
export const DEFAULT_HALF_LIFE_DAYS = 180;
export const DEFAULT_NEUTRAL_CONFIDENCE = 0.75;

export interface FusionWeights {
  sim: number;
  rec: number;
  conf: number;
}

export interface FusionOpts {
  weights?: Partial<FusionWeights>;
  halfLifeDays?: number;
  neutralConfidence?: number;
}

/** A scored recall row carrying the raw signals fusion needs. */
export interface RecalledRow {
  key: string;
  value: string;
  /** Raw embedding similarity in [0,1]; undefined for keyword-fallback rows. */
  similarity?: number;
  /** Age in days of the freshest relevant timestamp; undefined ⇒ no demotion. */
  ageDays?: number | null;
  /** Phase-4 extraction confidence in [0,1]; undefined/null ⇒ neutral. */
  confidence?: number | null;
}

/** Normalize weights to sum to 1; fall back to defaults on degenerate input. */
export function normalizeWeights(w?: Partial<FusionWeights>): FusionWeights {
  const sim = numOr(w?.sim, DEFAULT_WEIGHTS.sim);
  const rec = numOr(w?.rec, DEFAULT_WEIGHTS.rec);
  const conf = numOr(w?.conf, DEFAULT_WEIGHTS.conf);
  const total = sim + rec + conf;
  if (!(total > 0)) return { ...DEFAULT_WEIGHTS };
  return { sim: sim / total, rec: rec / total, conf: conf / total };
}

/** Exponential half-life recency decay in (0,1]; null/NaN age ⇒ 1 (fail-open). */
export function recencyFactor(
  ageDays: number | null | undefined,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  if (ageDays === null || ageDays === undefined || !Number.isFinite(ageDays)) return 1;
  const age = Math.max(0, ageDays);
  const hl = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : DEFAULT_HALF_LIFE_DAYS;
  return Math.pow(2, -age / hl);
}

/** Confidence multiplier ∈ (0,1]; null/undefined ⇒ neutral prior. */
export function confidenceFactorFor(
  confidence: number | null | undefined,
  neutral: number = DEFAULT_NEUTRAL_CONFIDENCE,
): number {
  const n = clamp01(Number.isFinite(neutral) ? neutral : DEFAULT_NEUTRAL_CONFIDENCE);
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) return n;
  return clamp01(confidence);
}

/**
 * Fuse similarity + recency + confidence into one score. Always ≤ similarity
 * (the weights sum to 1 and every factor ≤ 1). Never throws. A row missing
 * similarity (keyword fallback) is treated as similarity 1 so recency/confidence
 * still order it relative to peers without inventing a cosine score.
 */
export function fuseRecallScore(row: RecalledRow, opts?: FusionOpts): number {
  const w = normalizeWeights(opts?.weights);
  const sim = Number.isFinite(row.similarity) ? clamp01(row.similarity as number) : 1;
  const rf = recencyFactor(row.ageDays, opts?.halfLifeDays);
  const cf = confidenceFactorFor(row.confidence, opts?.neutralConfidence);
  return sim * (w.sim + w.rec * rf + w.conf * cf);
}

/**
 * Stable re-rank by fused score (desc). Ties keep input order (preserving the
 * incoming vector ORDER BY as the tie-break). Returns new row objects with a
 * `fused` score attached; does not mutate inputs.
 */
export function rerankByFusion<T extends RecalledRow>(
  rows: T[],
  opts?: FusionOpts,
): Array<T & { fused: number }> {
  return rows
    .map((r, i) => ({ r, i, fused: fuseRecallScore(r, opts) }))
    .sort((a, b) => b.fused - a.fused || a.i - b.i)
    .map(({ r, fused }) => ({ ...r, fused }));
}

/**
 * Reciprocal Rank Fusion for the union path — space-agnostic (rank-only), so it
 * sidesteps the incomparable OpenAI-1536 vs Titan-1024 similarity scales. Each
 * list contributes 1/(k+rank); a row's RRF contribution is multiplied by its
 * recency×confidence factor so fresh/confident rows still win ties. Dedupe by
 * key keeping the MAX combined score. Preserves first-seen order on exact ties.
 */
export function reciprocalRankFusion<T extends RecalledRow>(
  lists: T[][],
  opts?: FusionOpts & { k?: number },
): T[] {
  const k = Number.isFinite(opts?.k) && (opts?.k as number) > 0 ? (opts?.k as number) : 60;
  const best = new Map<string, { row: T; score: number; order: number }>();
  let order = 0;
  for (const list of lists) {
    list.forEach((row, rank) => {
      const rf = recencyFactor(row.ageDays, opts?.halfLifeDays);
      const cf = confidenceFactorFor(row.confidence, opts?.neutralConfidence);
      const contribution = (1 / (k + rank + 1)) * rf * cf;
      const prior = best.get(row.key);
      if (!prior) {
        best.set(row.key, { row, score: contribution, order: order++ });
      } else {
        prior.score += contribution;
      }
    });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((e) => e.row);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
function numOr(x: number | undefined, d: number): number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : d;
}
