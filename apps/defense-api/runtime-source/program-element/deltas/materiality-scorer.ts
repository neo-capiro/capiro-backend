/**
 * Step 1.4 — Materiality scorer (PURE, table-driven, unit-tested).
 *
 * Turns a typed budget delta into a single 0..1 materiality score plus the per-factor
 * contributions that produced it. No Prisma / Nest imports — the engine and the read
 * service both reuse this, and the spec drives it directly.
 *
 * The score is a WEIGHTED, CLAMPED sum of normalized factors (plan §6):
 *   - dollarMagnitude   log-scaled |Δ$| (a $1B swing is not 1000× a $1M swing)
 *   - pctMagnitude      |Δ%| (capped — a 0→$5M new start is +∞% but not infinitely material)
 *   - stageSignificance how far down the stage ladder this delta sits
 *                       (enacted > conference > marks > pb): a law is harder to move
 *                       than a request, so the same $ at "enacted" matters more.
 *   - clientRelevance   layered in PER-TENANT at READ time (default 0 here) — a tenant
 *                       that watches / has a capability on this PE gets a boost. NEVER
 *                       stored globally (each tenant sees a different relevance).
 *   - deadlineProximity placeholder hook (0 until Step 3.x wires real markup calendars).
 *   - unusualPattern    new_start / termination / zeroed / transfer_candidate get a flat
 *                       boost — a program starting or dying is categorically notable
 *                       regardless of size.
 *
 * Monotonicity is a contract (asserted in the spec): with all else equal, MORE $ → a
 * score that is ≥ the smaller-$ score, and the same delta at a LATER stage → ≥ score.
 */

export type DeltaTypeForScore =
  | 'pb_vs_prior_pb'
  | 'mark_vs_request'
  | 'mark_vs_mark'
  | 'conference_vs_marks'
  | 'enacted_vs_request'
  | 'new_start'
  | 'termination'
  | 'zeroed'
  | 'transfer_candidate'
  | 'quantity_change'
  | 'unit_cost_change'
  | 'outyear_shift'
  | 'project_level_change';

/** The stage a delta's TO-side asserts (drives stageSignificance). */
export type DeltaStage = 'pb' | 'marks' | 'conference' | 'enacted';

export interface MaterialityInput {
  deltaType: DeltaTypeForScore | string;
  /** Absolute $ change in MILLIONS (sign ignored — magnitude only). */
  deltaAbsM: number | null;
  /** Fractional change (e.g. 0.25 = +25%); null when there is no meaningful base. */
  deltaPct: number | null;
  /** Stage of the delta's TO-side. Defaults to 'pb' when unknown. */
  stage?: DeltaStage;
  /**
   * Per-tenant relevance in 0..1, computed at READ time (1 = tenant watches / has a
   * capability on this PE). Defaults to 0 — the stored, tenant-agnostic score.
   */
  clientRelevance?: number;
  /** Placeholder 0..1 deadline-proximity signal (Step 3.x). Defaults to 0. */
  deadlineProximity?: number;
}

/** Documented default weights. Sum need not be 1 — the result is clamped to [0,1]. */
export interface MaterialityWeights {
  dollarMagnitude: number;
  pctMagnitude: number;
  stageSignificance: number;
  clientRelevance: number;
  deadlineProximity: number;
  /** Flat additive boost for new_start / termination / zeroed / transfer_candidate. */
  unusualPattern: number;
}

/**
 * Defaults: dollar magnitude dominates, stage + pct meaningfully contribute, client
 * relevance is a strong per-tenant lever, the unusual-pattern boost is enough to push a
 * structural change (new start / kill) over the 0.4 "notable" line on its own.
 */
export const DEFAULT_MATERIALITY_WEIGHTS: MaterialityWeights = {
  dollarMagnitude: 0.4,
  pctMagnitude: 0.2,
  stageSignificance: 0.2,
  clientRelevance: 0.2,
  deadlineProximity: 0.1,
  unusualPattern: 0.25,
};

/** Alert thresholds (plan §6): ≥0.7 critical, ≥0.4 notable, else info. */
export const MATERIALITY_THRESHOLDS = { critical: 0.7, notable: 0.4 } as const;

/** Stage ladder rank → significance in 0..1. enacted > conference > marks > pb. */
const STAGE_SIGNIFICANCE: Record<DeltaStage, number> = {
  pb: 0.25,
  marks: 0.5,
  conference: 0.75,
  enacted: 1,
};

/** Delta types that earn the unusual-pattern boost. */
const UNUSUAL_TYPES = new Set<string>(['new_start', 'termination', 'zeroed', 'transfer_candidate']);

/**
 * Reference dollar magnitude (in $M) that saturates the dollarMagnitude factor to ~1.
 * A $1B (1000 $M) swing is treated as maximally material on the dollar axis; smaller
 * swings scale logarithmically below it, so the factor is strictly increasing in |Δ$|.
 */
const DOLLAR_SATURATION_M = 1000;

/** log-scaled, strictly-increasing dollar factor in [0,1]. 0 at |Δ$|=0, ~1 at saturation. */
export function dollarMagnitudeFactor(deltaAbsM: number | null): number {
  const m = Math.abs(deltaAbsM ?? 0);
  if (m <= 0) return 0;
  // log1p keeps it strictly monotonic and smooth; normalize by the saturation point.
  const v = Math.log1p(m) / Math.log1p(DOLLAR_SATURATION_M);
  return clamp01(v);
}

/** |Δ%| factor in [0,1], saturating at 100% so a wild 0→x new-start % doesn't dominate. */
export function pctMagnitudeFactor(deltaPct: number | null): number {
  if (deltaPct === null || !Number.isFinite(deltaPct)) return 0;
  return clamp01(Math.abs(deltaPct));
}

export interface MaterialityResult {
  score: number;
  factors: {
    dollarMagnitude: number;
    pctMagnitude: number;
    stageSignificance: number;
    clientRelevance: number;
    deadlineProximity: number;
    unusualPattern: number;
  };
  severity: 'info' | 'notable' | 'critical';
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Map a materiality score to the alert severity bucket. */
export function severityForScore(score: number): 'info' | 'notable' | 'critical' {
  if (score >= MATERIALITY_THRESHOLDS.critical) return 'critical';
  if (score >= MATERIALITY_THRESHOLDS.notable) return 'notable';
  return 'info';
}

/**
 * Score a delta's materiality in [0,1]. PURE: same input → same output. The returned
 * `factors` are the WEIGHTED contributions (each already ×weight) so they sum (clamped)
 * to `score` — handy for the materialityFactors jsonb and for explaining the score in UI.
 */
export function scoreMateriality(
  input: MaterialityInput,
  weights: MaterialityWeights = DEFAULT_MATERIALITY_WEIGHTS,
): MaterialityResult {
  const stage = input.stage ?? 'pb';
  const dollar = dollarMagnitudeFactor(input.deltaAbsM);
  const pct = pctMagnitudeFactor(input.deltaPct);
  const stageSig = STAGE_SIGNIFICANCE[stage];
  const relevance = clamp01(input.clientRelevance ?? 0);
  const deadline = clamp01(input.deadlineProximity ?? 0);
  const unusual = UNUSUAL_TYPES.has(input.deltaType) ? 1 : 0;

  const factors = {
    dollarMagnitude: dollar * weights.dollarMagnitude,
    pctMagnitude: pct * weights.pctMagnitude,
    stageSignificance: stageSig * weights.stageSignificance,
    clientRelevance: relevance * weights.clientRelevance,
    deadlineProximity: deadline * weights.deadlineProximity,
    unusualPattern: unusual * weights.unusualPattern,
  };

  const score = clamp01(
    factors.dollarMagnitude +
      factors.pctMagnitude +
      factors.stageSignificance +
      factors.clientRelevance +
      factors.deadlineProximity +
      factors.unusualPattern,
  );

  return { score, factors, severity: severityForScore(score) };
}

/**
 * Re-score a stored, tenant-agnostic delta WITH a per-tenant clientRelevance layered in.
 * The engine stores score with clientRelevance=0; the read service calls this to produce
 * the score a given tenant should see. Keeps the storage tenant-agnostic (one row, many
 * tenants) while honoring "clientRelevance is computed per-tenant at read time".
 */
export function rescoreWithClientRelevance(
  base: MaterialityInput,
  clientRelevance: number,
  weights: MaterialityWeights = DEFAULT_MATERIALITY_WEIGHTS,
): MaterialityResult {
  return scoreMateriality({ ...base, clientRelevance }, weights);
}
