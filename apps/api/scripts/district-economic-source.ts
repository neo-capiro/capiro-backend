import { PrismaClient, Prisma } from '@prisma/client';

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
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
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
      marginOfError: finiteOrNull(fact.marginOfError),
      naicsCode: fact.naicsCode?.trim() || null,
      unit: fact.unit?.trim() || null,
    });
  }

  try {
    if (!options.dryRun) {
      const chunkSize = 250;
      for (let offset = 0; offset < valid.length; offset += chunkSize) {
        const chunk = valid.slice(offset, offset + chunkSize);
        await prisma.$transaction(
          chunk.map((fact) =>
            prisma.$executeRaw(Prisma.sql`
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
            `),
          ),
        );
        rowsWritten += chunk.length;
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
