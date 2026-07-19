import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as ss from 'simple-statistics';
import { PrismaService } from '../../prisma/prisma.service.js';

const MODEL_VERSION = 'conference-probability-v1';
const Z_95 = 1.96;
const MIN_CONFIDENCE = 0.1;
const MAX_CONFIDENCE = 0.95;

interface PredictionRow {
  peCode: string;
  fy: number;
  service: string | null;
  request: unknown;
  hascMark: unknown;
  sascMark: unknown;
  conference: unknown;
}

interface CachedPredictionRow {
  predicted: unknown;
  ciLow: unknown;
  ciHigh: unknown;
  confidence: unknown;
}

export interface ConferencePrediction {
  predicted: number;
  ciLow: number;
  ciHigh: number;
  confidence: number;
}

interface ModelTrainingRow {
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

function toNumber(value: unknown): number | null {
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

@Injectable()
export class ConferenceProbabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Predict where the NDAA conference lands between the HASC/SASC marks.
   *
   * `persist` (GAI-25): when true (the default, used by the batch recompute
   * script) a freshly-computed prediction is cached via upsert. The Meri read
   * tool path (`get_pe_budget_timeline` -> ProgramElementReadService.getTimeline)
   * MUST pass `false` so a *read* never writes to `conference_probability` — it
   * still computes + returns a prediction in-memory, it just doesn't persist it.
   * The already-cached row is always served regardless of `persist`.
   */
  async predict(peCode: string, fy: number, persist = true): Promise<ConferencePrediction | null> {
    const targetRows = await this.prisma.$queryRaw<PredictionRow[]>(Prisma.sql`
      SELECT
        y.pe_code AS "peCode",
        y.fy AS "fy",
        p.service AS "service",
        y.request AS "request",
        y.hasc_mark AS "hascMark",
        y.sasc_mark AS "sascMark",
        -- This model predicts where the NDAA (authorization) conference lands between
        -- the HASC/SASC marks, so it reads ndaa_conference (aliased "conference").
        y.ndaa_conference AS "conference"
      FROM program_element_year y
      INNER JOIN program_element p ON p.pe_code = y.pe_code
      WHERE y.pe_code = ${peCode}
        AND y.fy = ${fy}
      LIMIT 1
    `);

    const target = targetRows[0];
    if (!target) return null;

    const hascMark = toNumber(target.hascMark);
    const sascMark = toNumber(target.sascMark);
    const request = toNumber(target.request);
    const conference = toNumber(target.conference);

    if (hascMark == null || sascMark == null || request == null || conference != null) {
      return null;
    }

    const cached = await this.prisma.$queryRaw<CachedPredictionRow[]>(Prisma.sql`
      SELECT
        predicted AS "predicted",
        ci_low AS "ciLow",
        ci_high AS "ciHigh",
        confidence AS "confidence"
      FROM conference_probability
      WHERE pe_code = ${peCode}
        AND fy = ${fy}
        AND model_version = ${MODEL_VERSION}
      LIMIT 1
    `);

    const cachedRow = cached[0];
    if (cachedRow) {
      const predicted = toNumber(cachedRow.predicted);
      const ciLow = toNumber(cachedRow.ciLow);
      const ciHigh = toNumber(cachedRow.ciHigh);
      const confidence = toNumber(cachedRow.confidence);
      if (predicted != null && ciLow != null && ciHigh != null && confidence != null) {
        return { predicted, ciLow, ciHigh, confidence };
      }
    }

    const gap = sascMark - hascMark;
    if (gap === 0) {
      const flatPrediction: ConferencePrediction = {
        predicted: hascMark,
        ciLow: hascMark,
        ciHigh: hascMark,
        confidence: MIN_CONFIDENCE,
      };
      if (persist) await this.upsertPrediction(peCode, fy, flatPrediction);
      return flatPrediction;
    }

    const service = target.service;
    if (!service) return null;

    const historyRows = await this.prisma.$queryRaw<PredictionRow[]>(Prisma.sql`
      SELECT
        y.pe_code AS "peCode",
        y.fy AS "fy",
        p.service AS "service",
        y.request AS "request",
        y.hasc_mark AS "hascMark",
        y.sasc_mark AS "sascMark",
        y.ndaa_conference AS "conference"
      FROM program_element_year y
      INNER JOIN program_element p ON p.pe_code = y.pe_code
      WHERE p.service = ${service}
        AND y.fy < ${fy}
        AND y.request IS NOT NULL
        AND y.hasc_mark IS NOT NULL
        AND y.sasc_mark IS NOT NULL
        AND y.ndaa_conference IS NOT NULL
    `);

    const modelRows: ModelTrainingRow[] = historyRows
      .map((row) => {
        const rowRequest = toNumber(row.request);
        const rowHasc = toNumber(row.hascMark);
        const rowSasc = toNumber(row.sascMark);
        const rowConference = toNumber(row.conference);
        if (rowRequest == null || rowHasc == null || rowSasc == null || rowConference == null)
          return null;
        return {
          request: rowRequest,
          hascMark: rowHasc,
          sascMark: rowSasc,
          conference: rowConference,
        };
      })
      .filter((row): row is ModelTrainingRow => row !== null);

    const prediction = buildConferencePredictionFromHistory(
      {
        request,
        hascMark,
        sascMark,
      },
      modelRows,
    );

    if (!prediction) return null;

    if (persist) await this.upsertPrediction(peCode, fy, prediction);
    return prediction;
  }

  private async upsertPrediction(
    peCode: string,
    fy: number,
    prediction: ConferencePrediction,
  ): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO conference_probability (
        pe_code,
        fy,
        predicted,
        ci_low,
        ci_high,
        confidence,
        model_version,
        computed_at
      )
      VALUES (
        ${peCode},
        ${fy},
        ${prediction.predicted},
        ${prediction.ciLow},
        ${prediction.ciHigh},
        ${prediction.confidence},
        ${MODEL_VERSION},
        NOW()
      )
      ON CONFLICT (pe_code, fy)
      DO UPDATE SET
        predicted = EXCLUDED.predicted,
        ci_low = EXCLUDED.ci_low,
        ci_high = EXCLUDED.ci_high,
        confidence = EXCLUDED.confidence,
        model_version = EXCLUDED.model_version,
        computed_at = EXCLUDED.computed_at
    `);
  }
}
