import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import type { PrismaClient } from '@prisma/client';
import { runEconomicSync } from './district-economic-sync.js';
import { parseCsvRecords } from '../src/district-nexus/district-nexus-csv.js';
import {
  envDryRun,
  recordEconomicSourceUnavailable,
  writeEconomicFacts,
  type EconomicFactInput,
  type EconomicSourceRunResult,
} from './district-economic-source.js';

function integerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

function finite(value: unknown): number | null {
  const text = clean(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function validDate(value: unknown): Date | null {
  const text = clean(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function sourceBytes(location: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(location)) {
    const response = await fetch(location);
    if (!response.ok) throw new Error(`LODES aggregate request failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(location);
}

function maybeGunzip(buffer: Buffer, location: string): Buffer {
  const gzip = location.toLowerCase().endsWith('.gz') || (buffer[0] === 0x1f && buffer[1] === 0x8b);
  return gzip ? gunzipSync(buffer) : buffer;
}

/**
 * Imports a district-level aggregate produced from official Census LODES
 * WAC/RAC/OD files plus a Census block→congressional-district crosswalk.
 *
 * Raw LODES files are block-level and do not publish a direct district API.
 * This importer therefore requires an aggregate artifact and its provenance
 * URL/path explicitly. Missing configuration is persisted as `unavailable`,
 * never represented as zero jobs. Expected columns:
 *
 * state,district,metric_key,value,unit[,source_year,boundary_congress,
 * source_record_id,observed_at]
 */
async function run(prisma: PrismaClient): Promise<EconomicSourceRunResult> {
  const location = process.env.LODES_DISTRICT_AGGREGATE?.trim();
  const sourceYear = integerEnv('LODES_YEAR', 2023);
  const boundaryCongress = integerEnv('DISTRICT_BOUNDARY_CONGRESS', 119);
  const dataset = process.env.LODES_DATASET?.trim() || 'lodes_wac_rac_od';
  if (!location) {
    const result = await recordEconomicSourceUnavailable(
      prisma,
      {
        source: 'lodes',
        dataset,
        sourceYear,
        boundaryCongress,
        metadata: {
          requiredSetting: 'LODES_DISTRICT_AGGREGATE',
          annualDataset: true,
        },
      },
      'LODES_DISTRICT_AGGREGATE is not configured. LODES remains unavailable rather than being represented as zero.',
    );
    console.log(JSON.stringify(result));
    return result;
  }

  const buffer = maybeGunzip(await sourceBytes(location), location);
  const rows = parseCsvRecords(buffer);
  const facts: EconomicFactInput[] = rows.map((row, index) => {
    const rowYear = finite(row.source_year);
    const rowCongress = finite(row.boundary_congress);
    const state = clean(row.state || row.state_code).toUpperCase();
    const districtCode = clean(row.district || row.district_code || row.congressional_district);
    const metricKey = clean(row.metric_key || row.metric || row.measure);
    const suppliedObservedAt = clean(row.observed_at);
    const parsedObservedAt = validDate(suppliedObservedAt);
    return {
      source: 'lodes',
      dataset,
      sourceYear: rowYear != null ? Math.round(rowYear) : sourceYear,
      state,
      districtCode,
      boundaryCongress: rowCongress != null ? Math.round(rowCongress) : boundaryCongress,
      metricKey,
      metricValue: finite(row.value ?? row.metric_value),
      unit: clean(row.unit) || 'jobs',
      sourceRecordId: clean(row.source_record_id) || `aggregate-row-${index + 1}`,
      sourceUrl: /^https?:\/\//i.test(location) ? location : null,
      observedAt: parsedObservedAt ?? new Date(`${sourceYear}-01-01T00:00:00.000Z`),
      metadata: {
        aggregationMethod:
          process.env.LODES_AGGREGATION_METHOD?.trim() ||
          'official_lodes_block_crosswalk_to_congressional_district',
        provenanceLocation: location,
        annualDataset: true,
        ...(suppliedObservedAt && !parsedObservedAt
          ? {
              observedAtWarning: `Invalid source observed_at: ${suppliedObservedAt}`,
            }
          : {}),
      },
    };
  });

  const result = await writeEconomicFacts(
    prisma,
    {
      source: 'lodes',
      dataset,
      sourceYear,
      boundaryCongress,
      dryRun: envDryRun(),
      metadata: {
        aggregateLocation: location,
        aggregationMethod:
          process.env.LODES_AGGREGATION_METHOD?.trim() ||
          'official_lodes_block_crosswalk_to_congressional_district',
      },
    },
    facts,
  );
  console.log(JSON.stringify(result));
  return result;
}

export async function main(): Promise<void> {
  await runEconomicSync('lodes', run);
}

if (
  /sync-district-economic-lodes(\.[cm]?[tj]s)?$/.test((process.argv[1] ?? '').replace(/\\/g, '/'))
) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
