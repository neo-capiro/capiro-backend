import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  buildConferencePredictionFromHistory,
  CONFERENCE_MODEL_VERSION,
  MIN_CONFIDENCE,
  toPredictionNumber,
  type ConferencePrediction,
  type ModelTrainingRow,
} from '@capiro/defense-domain/pe-read';

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

/**
 * READ-ONLY NDAA-conference forecast, for the PE timeline's per-year enrichment.
 *
 * This is `apps/api`'s `ConferenceProbabilityService.predict(peCode, fy, false)`
 * — the `persist = false` branch that the timeline read path is REQUIRED to use
 * (GAI-25: a read must never write). The persisting branch and its
 * `upsertPrediction` are deliberately absent here rather than gated behind a
 * flag: the HTTP task holds no INSERT/UPDATE grant on `conference_probability`,
 * so a write would fail at the database even if code asked for one. The
 * already-cached row is always served when present, exactly as apps/api does.
 *
 * The forecast MATH lives in `@capiro/defense-domain/pe-read`
 * (`buildConferencePredictionFromHistory`), shared with apps/api's copy and
 * pinned by the Session 3 parity suite.
 */
@Injectable()
export class ConferenceProbabilityReadService {
  constructor(private readonly prisma: PrismaService) {}

  async predict(peCode: string, fy: number): Promise<ConferencePrediction | null> {
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

    const hascMark = toPredictionNumber(target.hascMark);
    const sascMark = toPredictionNumber(target.sascMark);
    const request = toPredictionNumber(target.request);
    const conference = toPredictionNumber(target.conference);

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
        AND model_version = ${CONFERENCE_MODEL_VERSION}
      LIMIT 1
    `);

    const cachedRow = cached[0];
    if (cachedRow) {
      const predicted = toPredictionNumber(cachedRow.predicted);
      const ciLow = toPredictionNumber(cachedRow.ciLow);
      const ciHigh = toPredictionNumber(cachedRow.ciHigh);
      const confidence = toPredictionNumber(cachedRow.confidence);
      if (predicted != null && ciLow != null && ciHigh != null && confidence != null) {
        return { predicted, ciLow, ciHigh, confidence };
      }
    }

    const gap = sascMark - hascMark;
    if (gap === 0) {
      // apps/api persists this flat prediction when persist=true; the read path
      // never does, so it is computed and returned only.
      return {
        predicted: hascMark,
        ciLow: hascMark,
        ciHigh: hascMark,
        confidence: MIN_CONFIDENCE,
      };
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
        const rowRequest = toPredictionNumber(row.request);
        const rowHasc = toPredictionNumber(row.hascMark);
        const rowSasc = toPredictionNumber(row.sascMark);
        const rowConference = toPredictionNumber(row.conference);
        if (rowRequest == null || rowHasc == null || rowSasc == null || rowConference == null) {
          return null;
        }
        return {
          request: rowRequest,
          hascMark: rowHasc,
          sascMark: rowSasc,
          conference: rowConference,
        };
      })
      .filter((row): row is ModelTrainingRow => row !== null);

    return buildConferencePredictionFromHistory({ request, hascMark, sascMark }, modelRows);
  }
}
