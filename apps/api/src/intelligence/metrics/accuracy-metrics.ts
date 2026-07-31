/**
 * Step 4.1 — PURE accuracy-metric math for the §22 accuracy targets.
 *
 * No DB, no NestJS, no I/O. Every function takes a GOLDEN set (the human-verified
 * ground truth) and the ACTUAL values replayed from the current system, and returns a
 * single {@link MetricResult}: the measured fraction, the §22 target, and whether it
 * meets target. The CLI (`scripts/measure-accuracy.ts`) wires real DB reads into these;
 * the spec exercises them with mixed correct/incorrect fixtures.
 *
 * HONESTY NOTE: these functions compute the metric correctly, but they are only as
 * trustworthy as the golden set fed in. The committed golden sets under
 * `test/__golden__/` are SYNTHETIC placeholders — a real §22 number requires a
 * human-curated sample verified against the source PDFs (see that dir's README).
 *
 * Money convention: $ MILLIONS throughout (project-wide). `fundingValueAccuracy`
 * compares amounts already in millions; the default tolerance is in the same unit.
 */

/** One measured metric vs its §22 target. */
export interface MetricResult {
  /** Stable metric key (e.g. 'pe_identity_accuracy'). */
  metric: string;
  /**
   * Measured value in [0,1], or `null` when there was nothing to measure (empty
   * golden set / no live data to replay). A `null` value is NEVER a pass — it is
   * reported as "n/a" and `pass` is `false` so CI does not green-light an unmeasured
   * metric, but callers can distinguish "n/a" from a genuine miss via `value === null`.
   */
  value: number | null;
  /** The §22 target this metric must meet or exceed. */
  target: number;
  /** True iff `value !== null && value >= target`. */
  pass: boolean;
  /** Denominator used (sample size); 0 when the golden set was empty. */
  sampleSize: number;
}

/** Aggregate of every metric plus an overall gate. */
export interface AccuracySummary {
  metrics: MetricResult[];
  /** True iff every metric passed (and there was at least one metric). */
  allPass: boolean;
}

/**
 * §22 accuracy targets, exported as named constants so the CLI, the spec, and any
 * dashboard share one source of truth. Each is the minimum acceptable fraction.
 */
export const TARGETS = {
  /** PE identity (peCode + title) match — §22 ≥ 0.99. */
  PE_IDENTITY_ACCURACY: 0.99,
  /** Funding (BY amount) match within tolerance — §22 ≥ 0.99. */
  FUNDING_VALUE_ACCURACY: 0.99,
  /** Accepted PE→program match precision — §22 ≥ 0.95. */
  PROGRAM_MATCH_PRECISION: 0.95,
  /** Person→role precision — §22 ≥ 0.97. */
  PERSON_ROLE_PRECISION: 0.97,
  /** Delta classification accuracy — §22 ≥ 0.98. */
  DELTA_ACCURACY: 0.98,
  /**
   * Grounded field-row accuracy (identity + FY + field/stage + source SHA + page/span)
   * — Phase K permanent gate ≥ 0.99 when measured against human-reviewed goldens.
   */
  GROUNDED_FIELD_ACCURACY: 0.99,
  /** Current vs outyear / classification accuracy ≥ 0.98. */
  CLASSIFICATION_ACCURACY: 0.98,
} as const;

/**
 * Named metric families kept SEPARATE under Phase K. Dashboards and gates must
 * not collapse these into a single opaque score.
 */
export const METRIC_FAMILIES = [
  'precision',
  'recall',
  'coverage',
  'classification_accuracy',
  'false_positives',
  'false_negatives',
  'grounded_field_accuracy',
  'identity_accuracy',
  'funding_value_accuracy',
] as const;

export type MetricFamily = (typeof METRIC_FAMILIES)[number];

/** A row identifiable by `id`, the join key between golden and actual. */
export interface Identified {
  id: string;
}

/** Tokens for grounded PE golden rows (Phase K exact query keys). */
export interface GroundedFieldGolden extends Identified {
  peCode: string;
  fy: number;
  /** Canonical money/report field or narrative stage key. */
  field: string;
  /** Optional budget/legislative stage (request, hascMark, enacted, …). */
  stage?: string | null;
  /** Exact source document SHA-256 (lowercase hex). */
  sourceSha256: string;
  /** Human-verified page number (1-indexed) when known. */
  page?: number | null;
  /** Byte or char span inside the page/article, opaque to the metric math. */
  span?: string | null;
  /** Expected canonical value (stringified); optional when only provenance is scored. */
  expectedValue?: string | null;
  /**
   * Review provenance. Synthetic placeholders MUST set humanReviewed=false and
   * keep a loud syntheticWarning. Human rows require reviewer + reviewedAt.
   */
  humanReviewed: boolean;
  reviewer?: string | null;
  reviewedAt?: string | null;
  syntheticWarning?: string | null;
}

export interface GroundedFieldActual extends Identified {
  peCode: string | null;
  fy: number | null;
  field: string | null;
  stage?: string | null;
  sourceSha256: string | null;
  page?: number | null;
  span?: string | null;
  actualValue?: string | null;
}

export interface BinaryClassGolden extends Identified {
  /** Human label, e.g. 'current' | 'outyear' | 'rdt_e' | 'procurement'. */
  label: string;
}

export interface BinaryClassActual extends Identified {
  label: string | null;
}

/** Confusion counts kept as separate SaaS/SOC metrics — never blended. */
export interface ConfusionCounts {
  truePositives: number;
  trueNegatives: number;
  falsePositives: number;
  falseNegatives: number;
}

export interface SeparatedMetricBundle {
  precision: MetricResult;
  recall: MetricResult;
  /** Share of golden rows for which an actual decision existed. */
  coverage: MetricResult;
  classificationAccuracy: MetricResult;
  falsePositives: number;
  falseNegatives: number;
  confusion: ConfusionCounts;
}

function normSha(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function normToken(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Default tolerance (in $ MILLIONS) for `fundingValueAccuracy`. Two amounts count as
 * matching when |golden - actual| <= this. R-1 BY amounts are published to the nearest
 * $0.001M (thousands), so a small absolute tolerance absorbs rounding without masking a
 * real mismatch. Override per call when a golden set documents a different precision.
 */
export const FUNDING_TOLERANCE_M = 0.001;

// ---------------------------------------------------------------------------
// Golden / actual row shapes. Kept deliberately minimal — only the fields each
// metric compares. The CLI maps DB rows into these.
// ---------------------------------------------------------------------------

export interface R1IdentityGolden extends Identified {
  peCode: string;
  title: string;
}
export interface R1IdentityActual extends Identified {
  peCode: string | null;
  title: string | null;
}

export interface FundingGolden extends Identified {
  /** Budget-year amount in $ MILLIONS. */
  byAmount: number;
}
export interface FundingActual extends Identified {
  byAmount: number | null;
}

/**
 * A binary-label golden row: `correct` is the human verdict for the corresponding
 * actual decision. Used for program-match and person-role precision. Precision is
 * measured over the rows the SYSTEM accepted; an `accepted` flag on the actual lets
 * the CLI pass the full sample and have the metric restrict to accepted rows.
 */
export interface LabelGolden extends Identified {
  /** Human verdict: was this (accepted) decision actually correct? */
  correct: boolean;
}
export interface DecisionActual extends Identified {
  /** Did the system ACCEPT this match/record? Precision is over accepted-only. */
  accepted: boolean;
}

export interface DeltaGolden extends Identified {
  /** The human-verified delta classification (e.g. 'cut' | 'increase' | 'new_start'). */
  deltaType: string;
}
export interface DeltaActual extends Identified {
  deltaType: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Index `actual` by id for O(1) lookup against the golden set. */
function byId<T extends Identified>(actual: readonly T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const row of actual) m.set(row.id, row);
  return m;
}

/**
 * Build a {@link MetricResult} from a hit count over a denominator. An empty
 * denominator yields `value: null` / `pass: false` (documented "n/a" behaviour — an
 * unmeasured metric is never a silent pass).
 */
function ratioResult(metric: string, hits: number, denom: number, target: number): MetricResult {
  if (denom === 0) {
    return { metric, value: null, target, pass: false, sampleSize: 0 };
  }
  const value = hits / denom;
  return { metric, value, target, pass: value >= target, sampleSize: denom };
}

/** Trim + case-fold a title for resilient comparison (whitespace/case are not signal). */
function normTitle(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// §22 metrics
// ---------------------------------------------------------------------------

/**
 * PE identity accuracy (§22 ≥ 0.99): fraction of sampled R-1 rows whose (peCode, title)
 * both match the golden row. A missing actual row (the PE wasn't found at all) counts
 * as a miss. peCode is compared case-insensitively (e.g. `0604123a` == `0604123A`);
 * title is compared after whitespace/case normalization.
 */
export function peIdentityAccuracy(
  golden: readonly R1IdentityGolden[],
  actual: readonly R1IdentityActual[],
): MetricResult {
  const index = byId(actual);
  let hits = 0;
  for (const g of golden) {
    const a = index.get(g.id);
    if (!a) continue;
    const peMatch = (a.peCode ?? '').trim().toLowerCase() === g.peCode.trim().toLowerCase();
    const titleMatch = normTitle(a.title) === normTitle(g.title);
    if (peMatch && titleMatch) hits++;
  }
  return ratioResult('pe_identity_accuracy', hits, golden.length, TARGETS.PE_IDENTITY_ACCURACY);
}

/**
 * Funding-value accuracy (§22 ≥ 0.99): fraction of sampled rows whose BY amount matches
 * the golden amount within `toleranceM` ($ MILLIONS). A null actual amount is a miss.
 */
export function fundingValueAccuracy(
  golden: readonly FundingGolden[],
  actual: readonly FundingActual[],
  toleranceM: number = FUNDING_TOLERANCE_M,
): MetricResult {
  const index = byId(actual);
  let hits = 0;
  for (const g of golden) {
    const a = index.get(g.id);
    if (!a || a.byAmount === null || a.byAmount === undefined) continue;
    if (Math.abs(a.byAmount - g.byAmount) <= toleranceM) hits++;
  }
  return ratioResult('funding_value_accuracy', hits, golden.length, TARGETS.FUNDING_VALUE_ACCURACY);
}

/**
 * Accepted PE→program match PRECISION (§22 ≥ 0.95): of the matches the SYSTEM accepted,
 * the fraction the golden set labels correct. The denominator is accepted-only (rows
 * where `actual.accepted === true`); golden rows with no corresponding accepted actual
 * are ignored (they were not accepted, so they cannot lower precision). A golden row
 * missing from `actual` for an accepted id counts as incorrect (we accepted something
 * the human never verified as correct).
 */
export function programMatchPrecision(
  golden: readonly LabelGolden[],
  actual: readonly DecisionActual[],
): MetricResult {
  return labelPrecision('program_match_precision', golden, actual, TARGETS.PROGRAM_MATCH_PRECISION);
}

/**
 * Person→role PRECISION (§22 ≥ 0.97): analogous to {@link programMatchPrecision} over
 * accepted person-role records.
 */
export function personRolePrecision(
  golden: readonly LabelGolden[],
  actual: readonly DecisionActual[],
): MetricResult {
  return labelPrecision('person_role_precision', golden, actual, TARGETS.PERSON_ROLE_PRECISION);
}

/** Shared precision-over-accepted body for the two label-precision metrics. */
function labelPrecision(
  metric: string,
  golden: readonly LabelGolden[],
  actual: readonly DecisionActual[],
  target: number,
): MetricResult {
  const goldenIndex = byId(golden);
  let accepted = 0;
  let correct = 0;
  for (const a of actual) {
    if (!a.accepted) continue;
    accepted++;
    const g = goldenIndex.get(a.id);
    // Accepted but unverified, or verified-incorrect → not a true positive.
    if (g && g.correct) correct++;
  }
  return ratioResult(metric, correct, accepted, target);
}

/**
 * Delta classification accuracy (§22 ≥ 0.98): fraction of sampled deltas whose `deltaType`
 * matches the golden classification (case-insensitive). A null actual classification is a
 * miss.
 */
export function deltaAccuracy(
  golden: readonly DeltaGolden[],
  actual: readonly DeltaActual[],
): MetricResult {
  const index = byId(actual);
  let hits = 0;
  for (const g of golden) {
    const a = index.get(g.id);
    if (!a || a.deltaType === null || a.deltaType === undefined) continue;
    if (a.deltaType.trim().toLowerCase() === g.deltaType.trim().toLowerCase()) hits++;
  }
  return ratioResult('delta_accuracy', hits, golden.length, TARGETS.DELTA_ACCURACY);
}

/**
 * Roll up a set of {@link MetricResult}s. `allPass` is true only when there is at least
 * one metric AND every metric passed (so an all-empty run is NOT a pass).
 */
export function summarize(results: readonly MetricResult[]): AccuracySummary {
  return {
    metrics: [...results],
    allPass: results.length > 0 && results.every((r) => r.pass),
  };
}


// ---------------------------------------------------------------------------
// Phase K — grounded field rows + separated precision/recall/coverage
// ---------------------------------------------------------------------------

/**
 * Exact grounded-field accuracy: a row hits only when identity (peCode), FY,
 * field, optional stage, source SHA-256, and page/span ALL match the golden.
 * Missing actual rows are misses. underlying values are compared only when the
 * golden supplies expectedValue.
 */
export function groundedFieldAccuracy(
  golden: readonly GroundedFieldGolden[],
  actual: readonly GroundedFieldActual[],
): MetricResult {
  const index = byId(actual);
  let hits = 0;
  for (const g of golden) {
    const a = index.get(g.id);
    if (!a) continue;
    const identity =
      normToken(a.peCode) === normToken(g.peCode) &&
      a.fy === g.fy &&
      normToken(a.field) === normToken(g.field);
    const stageOk =
      g.stage === undefined || g.stage === null
        ? true
        : normToken(a.stage) === normToken(g.stage);
    const shaOk = normSha(a.sourceSha256) === normSha(g.sourceSha256) && normSha(g.sourceSha256) !== '';
    const pageOk =
      g.page === undefined || g.page === null ? true : a.page === g.page;
    const spanOk =
      g.span === undefined || g.span === null || g.span === ''
        ? true
        : (a.span ?? '') === g.span;
    const valueOk =
      g.expectedValue === undefined || g.expectedValue === null
        ? true
        : (a.actualValue ?? '') === g.expectedValue;
    if (identity && stageOk && shaOk && pageOk && spanOk && valueOk) hits++;
  }
  return ratioResult(
    'grounded_field_accuracy',
    hits,
    golden.length,
    TARGETS.GROUNDED_FIELD_ACCURACY,
  );
}

/**
 * Require loud synthetic labelling. Returns blockers when any row claims
 * humanReviewed without reviewer/date, or when synthetic rows omit the warning.
 */
export function auditGoldenReviewProvenance(
  rows: readonly GroundedFieldGolden[],
): { ok: boolean; blockers: string[] } {
  const blockers: string[] = [];
  for (const row of rows) {
    if (row.humanReviewed) {
      if (!row.reviewer || !String(row.reviewer).trim()) {
        blockers.push(`${row.id}: humanReviewed=true requires reviewer`);
      }
      if (!row.reviewedAt || !String(row.reviewedAt).trim()) {
        blockers.push(`${row.id}: humanReviewed=true requires reviewedAt`);
      }
      if (row.syntheticWarning) {
        blockers.push(`${row.id}: human-reviewed row must not carry syntheticWarning`);
      }
    } else {
      const warn = (row.syntheticWarning ?? '').toUpperCase();
      if (!warn.includes('SYNTHETIC') && !warn.includes('NOT HUMAN')) {
        blockers.push(
          `${row.id}: synthetic row requires loud syntheticWarning (must mention SYNTHETIC or NOT HUMAN)`,
        );
      }
    }
    if (!row.sourceSha256 || normSha(row.sourceSha256).length !== 64) {
      // Allow placeholder 64-char hex OR explicit empty only when synthetic and warned.
      if (row.humanReviewed) {
        blockers.push(`${row.id}: human-reviewed row requires 64-char sourceSha256`);
      }
    }
  }
  return { ok: blockers.length === 0, blockers };
}

/**
 * Multi-class classification accuracy (current/outyear, PE vs non-PE line, …).
 */
export function classificationAccuracy(
  golden: readonly BinaryClassGolden[],
  actual: readonly BinaryClassActual[],
): MetricResult {
  const index = byId(actual);
  let hits = 0;
  for (const g of golden) {
    const a = index.get(g.id);
    if (!a || a.label == null) continue;
    if (normToken(a.label) === normToken(g.label)) hits++;
  }
  return ratioResult(
    'classification_accuracy',
    hits,
    golden.length,
    TARGETS.CLASSIFICATION_ACCURACY,
  );
}

/**
 * Separated precision / recall / coverage / FP / FN for a positive class label.
 * Metrics remain independent MetricResult objects — never averaged silently.
 */
export function separatedBinaryMetrics(
  golden: readonly BinaryClassGolden[],
  actual: readonly BinaryClassActual[],
  positiveLabel: string,
  targets?: {
    precision?: number;
    recall?: number;
    coverage?: number;
    classification?: number;
  },
): SeparatedMetricBundle {
  const pos = normToken(positiveLabel);
  const index = byId(actual);
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  let covered = 0;

  for (const g of golden) {
    const a = index.get(g.id);
    if (!a || a.label == null || a.label === '') {
      // No system decision → uncovered; also counts as FN if golden is positive.
      if (normToken(g.label) === pos) fn++;
      continue;
    }
    covered++;
    const gPos = normToken(g.label) === pos;
    const aPos = normToken(a.label) === pos;
    if (gPos && aPos) tp++;
    else if (!gPos && !aPos) tn++;
    else if (!gPos && aPos) fp++;
    else fn++;
  }

  const precisionTarget = targets?.precision ?? TARGETS.PROGRAM_MATCH_PRECISION;
  const recallTarget = targets?.recall ?? TARGETS.PROGRAM_MATCH_PRECISION;
  const coverageTarget = targets?.coverage ?? 0.95;
  const classTarget = targets?.classification ?? TARGETS.CLASSIFICATION_ACCURACY;

  const precisionDenom = tp + fp;
  const recallDenom = tp + fn;
  const classDenom = tp + tn + fp + fn;

  return {
    precision: ratioResult('precision', tp, precisionDenom, precisionTarget),
    recall: ratioResult('recall', tp, recallDenom, recallTarget),
    coverage: ratioResult('coverage', covered, golden.length, coverageTarget),
    classificationAccuracy: ratioResult(
      'classification_accuracy',
      tp + tn,
      classDenom,
      classTarget,
    ),
    falsePositives: fp,
    falseNegatives: fn,
    confusion: {
      truePositives: tp,
      trueNegatives: tn,
      falsePositives: fp,
      falseNegatives: fn,
    },
  };
}
