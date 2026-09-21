import { PrismaClient, Prisma } from '@prisma/client';
import {
  DistrictNexusChangeWriter,
  detectEconomicFactChange,
} from '../src/district-nexus/priority-intelligence/priority-intelligence-changes.js';

export type EconomicSourceName = 'acs' | 'cbp' | 'lodes';

export interface EconomicFactInput {
  source: EconomicSourceName;
  dataset: string;
  sourceYear: number;
  state: string;
  districtCode: string;
  boundaryCongress: number | null;
  metricKey: string;
  metricValue: number | null;
  unit: string | null;
  marginOfError?: number | null;
  naicsCode?: string | null;
  sourceRecordId?: string | null;
  sourceUrl?: string | null;
  observedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface EconomicSourceRunOptions {
  source: EconomicSourceName;
  dataset: string;
  sourceYear: number | null;
  boundaryCongress: number | null;
  dryRun: boolean;
  metadata?: Record<string, unknown>;
}

export interface EconomicSourceRunResult {
  runId: string;
  rowsSeen: number;
  rowsWritten: number;
  rowsRejected: number;
  status: 'success' | 'success_with_errors' | 'failed' | 'unavailable';
  /**
   * District Nexus change-ledger rows written for this run (economic_fact
   * material changes only — never a tenant-scoped count). Optional: a dry
   * run or an unavailable-source call never reaches change detection, so
   * this is absent rather than a misleading 0 in those paths.
   */
  changesWritten?: number;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

export function positiveEconomicMarginOrNull(value: number | null | undefined): number | null {
  const normalized = finiteOrNull(value);
  return normalized != null && normalized > 0 ? normalized : null;
}

function normalizeDistrict(value: string): string | null {
  const text = value.trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  return String(Number(text)).padStart(2, '0');
}

function normalizeState(value: string): string | null {
  const text = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

/**
 * Append one source-run row and upsert facts in deterministic chunks. A dry run
 * validates/normalizes every row and records the result, but writes no facts.
 * Re-running the same source/year/district/metric is idempotent through the
 * expression unique index installed by Release 3.
 */
export async function writeEconomicFacts(
  prisma: PrismaClient,
  options: EconomicSourceRunOptions,
  input: EconomicFactInput[],
): Promise<EconomicSourceRunResult> {
  const started = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO district_economic_source_run (
      source, dataset, source_year, boundary_congress, status, dry_run,
      attempted_at, metadata_jsonb
    ) VALUES (
      ${options.source}, ${options.dataset}, ${options.sourceYear},
      ${options.boundaryCongress}, 'running', ${options.dryRun}, now(),
      ${JSON.stringify(options.metadata ?? {})}::jsonb
    )
    RETURNING id::text AS id
  `);
  const runId = started[0]?.id;
  if (!runId) throw new Error('Unable to create economic source run');

  let rowsSeen = 0;
  let rowsWritten = 0;
  let rowsRejected = 0;
  const valid: EconomicFactInput[] = [];
  for (const fact of input) {
    rowsSeen += 1;
    const state = normalizeState(fact.state);
    const districtCode = normalizeDistrict(fact.districtCode);
    if (
      fact.source !== options.source ||
      fact.dataset !== options.dataset ||
      !Number.isInteger(fact.sourceYear) ||
      !state ||
      !districtCode ||
      !fact.metricKey.trim()
    ) {
      rowsRejected += 1;
      continue;
    }
    valid.push({
      ...fact,
      state,
      districtCode,
      metricKey: fact.metricKey.trim(),
      metricValue: finiteOrNull(fact.metricValue),
      marginOfError: positiveEconomicMarginOrNull(fact.marginOfError),
      naicsCode: fact.naicsCode?.trim() || null,
      unit: fact.unit?.trim() || null,
    });
  }

  const changeWriter = new DistrictNexusChangeWriter(prisma as never);
  let changesWritten = 0;

  try {
    if (!options.dryRun) {
      const chunkSize = 250;
      const TX_TIMEOUT_MS = 120_000;
      for (let offset = 0; offset < valid.length; offset += chunkSize) {
        const chunk = valid.slice(offset, offset + chunkSize);
        await prisma.$transaction(
          async (tx) => {
            for (const fact of chunk) {
              // Fact write + old-value capture in ONE statement: the WITH
              // clause is evaluated against the pre-statement snapshot, so
              // old_fact holds the row's value BEFORE this upsert touches it
              // — even though district_economic_fact is upsert-in-place
              // (unlike GSA's append-only history), this still gets a true
              // old/new pair without a separate round trip, and without a
              // race between "read" and "write" since both happen in the
              // same statement inside this transaction.
              // "Prior" is the most recent existing row for this metric
              // IDENTITY (source/dataset/state/district/boundary_congress/
              // metric_key/naics), at a source_year no later than this fact's
              // own year — NOT an exact source_year match. source_year is
              // part of the upsert's conflict target, so a genuinely new
              // vintage (e.g. 2024's first value) creates a brand-new row
              // rather than overwriting 2023's; comparing only against an
              // exact-year match would make every new-vintage row look like
              // a first-ever population (priorValue always null) and never
              // detect a real year-over-year movement. Ordering by
              // `source_year <= this year, most recent first` naturally
              // prefers an exact same-year row when one exists (a same-year
              // correction/re-publication) and otherwise falls back to the
              // latest earlier vintage (a genuine year-over-year comparison).
              const rows = await tx.$queryRaw<
                Array<{ old_metric_value: string | null; old_source_year: number | null }>
              >(Prisma.sql`
                WITH old_fact AS (
                  SELECT metric_value, source_year
                  FROM district_economic_fact
                  WHERE source = ${fact.source} AND dataset = ${fact.dataset}
                    AND source_year <= ${fact.sourceYear} AND state = ${fact.state}
                    AND district_code = ${fact.districtCode}
                    AND (COALESCE(boundary_congress, -1)) = COALESCE(${fact.boundaryCongress}, -1)
                    AND metric_key = ${fact.metricKey}
                    AND (COALESCE(naics_code, '')) = COALESCE(${fact.naicsCode ?? null}, '')
                  ORDER BY source_year DESC
                  LIMIT 1
                )
                INSERT INTO district_economic_fact (
                  source, dataset, source_year, geography_type, state,
                  district_code, boundary_congress, metric_key, metric_value,
                  unit, margin_of_error, naics_code, source_record_id, source_url,
                  metadata_jsonb, observed_at, last_synced_at
                ) VALUES (
                  ${fact.source}, ${fact.dataset}, ${fact.sourceYear},
                  'congressional_district', ${fact.state}, ${fact.districtCode},
                  ${fact.boundaryCongress}, ${fact.metricKey}, ${fact.metricValue},
                  ${fact.unit}, ${fact.marginOfError ?? null},
                  ${fact.naicsCode ?? null}, ${fact.sourceRecordId ?? null},
                  ${fact.sourceUrl ?? null},
                  ${JSON.stringify(fact.metadata ?? {})}::jsonb,
                  ${fact.observedAt ?? null}, now()
                )
                ON CONFLICT (
                  source, dataset, source_year, state, district_code,
                  (COALESCE(boundary_congress, -1)), metric_key,
                  (COALESCE(naics_code, ''))
                ) DO UPDATE SET
                  metric_value = EXCLUDED.metric_value,
                  unit = EXCLUDED.unit,
                  margin_of_error = EXCLUDED.margin_of_error,
                  source_record_id = EXCLUDED.source_record_id,
                  source_url = EXCLUDED.source_url,
                  metadata_jsonb = EXCLUDED.metadata_jsonb,
                  observed_at = EXCLUDED.observed_at,
                  last_synced_at = now()
                RETURNING
                  (SELECT metric_value FROM old_fact)::text AS old_metric_value,
                  (SELECT source_year FROM old_fact) AS old_source_year
              `);
              rowsWritten += 1;

              const priorValue = rows[0]?.old_metric_value ?? null;
              const priorYear = rows[0]?.old_source_year;
              // priorYear is only ever read by detectEconomicFactChange when
              // priorValue is non-null (i.e. a prior row genuinely existed),
              // so a first-ever vintage (no prior row → priorValue null) has
              // explicit baseline semantics: it can never reach here as a
              // "change" — detectEconomicFactChange returns [] whenever
              // either side is missing, which is exactly "identical rerun /
              // no prior to compare" as well as "first-ever population".
              const changes = detectEconomicFactChange({
                source: fact.source,
                dataset: fact.dataset,
                stateCode: fact.state,
                districtCode: fact.districtCode,
                metricKey: fact.metricKey,
                naicsCode: fact.naicsCode ?? null,
                priorYear: priorYear ?? fact.sourceYear,
                priorValue,
                currentYear: fact.sourceYear,
                currentValue: fact.metricValue == null ? null : String(fact.metricValue),
                observedAt: fact.observedAt ?? new Date(),
              });
              if (changes.length > 0) {
                const summary = await changeWriter.writeChanges(changes, tx);
                changesWritten += summary.written;
              }
            }
          },
          { timeout: TX_TIMEOUT_MS, maxWait: 30_000 },
        );
      }
    }

    const status = rowsRejected ? 'success_with_errors' : 'success';
    await prisma.$executeRaw(Prisma.sql`
      UPDATE district_economic_source_run
      SET status = ${status}, completed_at = now(),
          rows_seen = ${rowsSeen}, rows_written = ${options.dryRun ? 0 : rowsWritten},
          rows_rejected = ${rowsRejected}
      WHERE id = ${runId}::uuid
    `);
    return {
      runId,
      rowsSeen,
      rowsWritten: options.dryRun ? 0 : rowsWritten,
      rowsRejected,
      status,
      changesWritten: options.dryRun ? 0 : changesWritten,
    };
  } catch (error) {
    await prisma.$executeRaw(Prisma.sql`
      UPDATE district_economic_source_run
      SET status = 'failed', completed_at = now(),
          rows_seen = ${rowsSeen}, rows_written = ${rowsWritten},
          rows_rejected = ${rowsRejected},
          error = ${error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000)}
      WHERE id = ${runId}::uuid
    `);
    throw error;
  }
}

export async function recordEconomicSourceUnavailable(
  prisma: PrismaClient,
  options: Omit<EconomicSourceRunOptions, 'dryRun'>,
  reason: string,
): Promise<EconomicSourceRunResult> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO district_economic_source_run (
      source, dataset, source_year, boundary_congress, status, dry_run,
      attempted_at, completed_at, rows_seen, rows_written, rows_rejected,
      error, metadata_jsonb
    ) VALUES (
      ${options.source}, ${options.dataset}, ${options.sourceYear},
      ${options.boundaryCongress}, 'unavailable', true, now(), now(),
      0, 0, 0, ${reason.slice(0, 4000)},
      ${JSON.stringify(options.metadata ?? {})}::jsonb
    )
    RETURNING id::text AS id
  `);
  return {
    runId: rows[0]?.id ?? '',
    rowsSeen: 0,
    rowsWritten: 0,
    rowsRejected: 0,
    status: 'unavailable',
  };
}

export function envDryRun(): boolean {
  return process.env.DRY_RUN?.trim().toLowerCase() !== 'false';
}
