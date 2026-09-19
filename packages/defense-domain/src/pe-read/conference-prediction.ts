/**
 * NDAA-conference landing-point prediction — the pure model.
 *
 * Hoisted verbatim from `buildConferencePredictionFromHistory` in
 * `apps/api/src/program-element/models/conference-probability.service.ts` so
 * defense-api's timeline enrichment produces the SAME forecast numbers without
 * importing apps/api. The Nest service around it (DB reads + the persist-on-write
 * cache) stays app-side; defense-api's own read-only wrapper never persists.
 *
 * Uses the same `simple-statistics` regression/stddev calls as apps/api rather
 * than a hand-rolled OLS, because a re-derived implementation would agree to
 * within float noise but not exactly — and this feeds money-adjacent forecast
 * fields that a parity suite compares by deep equality.
 */
// v7.12 publishes a CommonJS runtime entry, but marks its shared declaration
// entry as ESM. Use the package's explicit `require` condition from this CJS
// package and type only the two calls the model makes.
const ss = require('simple-statistics') as {
  linearRegression(data: Array<[number, number]>): { m: number; b: number };
  sampleStandardDeviation(values: number[]): number;
};

export const CONFERENCE_MODEL_VERSION = 'conference-probability-v1';
const Z_95 = 1.96;
export const MIN_CONFIDENCE = 0.1;
export const MAX_CONFIDENCE = 0.95;

export interface ConferencePrediction {
  predicted: number;
  ciLow: number;
  ciHigh: number;
  confidence: number;
}

export interface ModelTrainingRow {
  request: number;
  hascMark: number;
  sascMark: number;
  conference: number;
}

interface ModelFeatures {
  gap: number;
  gapPctOfRequest: number;
  sascHigher: boolean;
  closureRatio: number;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function toFeatures(row: ModelTrainingRow): ModelFeatures | null {
  const gap = row.sascMark - row.hascMark;
  if (gap === 0) return null;

  const actualClosure = row.conference - row.hascMark;
  const closureRatio = actualClosure / gap;
  const gapPctOfRequest = row.request === 0 ? 0 : gap / row.request;

  return {
    gap,
    gapPctOfRequest,
    sascHigher: gap > 0,
    closureRatio,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Coerce a DB money/float value (number | string | Prisma.Decimal-like) to a
 * finite number, or null. Hoisted with the model because the caller needs the
 * exact same coercion the apps/api service applies before feeding the model.
 */
export function toPredictionNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    const maybeDecimal = value as { toNumber?: () => number };
    if (typeof maybeDecimal.toNumber === 'function') {
      const parsed = maybeDecimal.toNumber();
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

export function buildConferencePredictionFromHistory(
  target: Pick<ModelTrainingRow, 'request' | 'hascMark' | 'sascMark'>,
  historicalRows: ModelTrainingRow[],
): ConferencePrediction | null {
  const gap = target.sascMark - target.hascMark;

  if (gap === 0) {
    return {
      predicted: target.hascMark,
      ciLow: target.hascMark,
      ciHigh: target.hascMark,
      confidence: MIN_CONFIDENCE,
    };
  }

  const features = historicalRows
    .map(toFeatures)
    .filter((row): row is ModelFeatures => row !== null);
  if (features.length === 0) return null;

  const regressionData = features.map(
    (row) => [row.gapPctOfRequest, row.closureRatio] as [number, number],
  );

  let slope = 0;
  let intercept = average(features.map((row) => row.closureRatio));

  if (regressionData.length >= 2) {
    const model = ss.linearRegression(regressionData);
    slope = Number.isFinite(model.m) ? model.m : 0;
    intercept = Number.isFinite(model.b) ? model.b : intercept;
  }

  const overallMean = average(features.map((row) => row.closureRatio));
  const targetSascHigher = gap > 0;
  const sameDirection = features
    .filter((row) => row.sascHigher === targetSascHigher)
    .map((row) => row.closureRatio);
  const directionMean = sameDirection.length > 0 ? average(sameDirection) : overallMean;
  const directionBias = directionMean - overallMean;

  const targetGapPct = target.request === 0 ? 0 : gap / target.request;
  const predictedClosureRatio = clamp(intercept + slope * targetGapPct + directionBias, -0.5, 1.5);

  const residuals = features.map((row) => {
    const rowDirectionMean = row.sascHigher === targetSascHigher ? directionMean : overallMean;
    const rowDirectionBias = rowDirectionMean - overallMean;
    const predictedRow = clamp(
      intercept + slope * row.gapPctOfRequest + rowDirectionBias,
      -0.5,
      1.5,
    );
    return row.closureRatio - predictedRow;
  });

  const residualStd = residuals.length >= 2 ? ss.sampleStandardDeviation(residuals) : 0;
  const ratioCiLow = predictedClosureRatio - Z_95 * residualStd;
  const ratioCiHigh = predictedClosureRatio + Z_95 * residualStd;

  const predicted = target.hascMark + predictedClosureRatio * gap;
  const ciCandidateA = target.hascMark + ratioCiLow * gap;
  const ciCandidateB = target.hascMark + ratioCiHigh * gap;

  const ciLow = Math.min(ciCandidateA, ciCandidateB);
  const ciHigh = Math.max(ciCandidateA, ciCandidateB);

  const sampleWeight = Math.min(1, features.length / 10);
  const noisePenalty = 1 / (1 + residualStd * 2);
  const confidence = clamp(sampleWeight * noisePenalty, MIN_CONFIDENCE, MAX_CONFIDENCE);

  return {
    predicted,
    ciLow,
    ciHigh,
    confidence,
  };
}
