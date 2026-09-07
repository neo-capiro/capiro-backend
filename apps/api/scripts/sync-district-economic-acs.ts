import type { PrismaClient } from '@prisma/client';
import { runEconomicSync } from './district-economic-sync.js';
import {
  envDryRun,
  writeEconomicFacts,
  type EconomicFactInput,
  type EconomicSourceRunResult,
} from './district-economic-source.js';

const FIPS_TO_STATE: Record<string, string> = {
  '01': 'AL',
  '02': 'AK',
  '04': 'AZ',
  '05': 'AR',
  '06': 'CA',
  '08': 'CO',
  '09': 'CT',
  '10': 'DE',
  '11': 'DC',
  '12': 'FL',
  '13': 'GA',
  '15': 'HI',
  '16': 'ID',
  '17': 'IL',
  '18': 'IN',
  '19': 'IA',
  '20': 'KS',
  '21': 'KY',
  '22': 'LA',
  '23': 'ME',
  '24': 'MD',
  '25': 'MA',
  '26': 'MI',
  '27': 'MN',
  '28': 'MS',
  '29': 'MO',
  '30': 'MT',
  '31': 'NE',
  '32': 'NV',
  '33': 'NH',
  '34': 'NJ',
  '35': 'NM',
  '36': 'NY',
  '37': 'NC',
  '38': 'ND',
  '39': 'OH',
  '40': 'OK',
  '41': 'OR',
  '42': 'PA',
  '44': 'RI',
  '45': 'SC',
  '46': 'SD',
  '47': 'TN',
  '48': 'TX',
  '49': 'UT',
  '50': 'VT',
  '51': 'VA',
  '53': 'WA',
  '54': 'WV',
  '55': 'WI',
  '56': 'WY',
  '60': 'AS',
  '66': 'GU',
  '69': 'MP',
  '72': 'PR',
  '78': 'VI',
};

const METRICS = [
  ['total_population', 'B01003_001E', 'B01003_001M', 'people'],
  ['median_household_income_usd', 'B19013_001E', 'B19013_001M', 'USD'],
  ['civilian_labor_force', 'B23025_003E', 'B23025_003M', 'people'],
  ['unemployed_population', 'B23025_005E', 'B23025_005M', 'people'],
] as const;

function integerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function finite(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!text || text.startsWith('-666') || text.startsWith('-888')) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

async function run(prisma: PrismaClient): Promise<EconomicSourceRunResult> {
  const year = integerEnv('ACS_YEAR', 2024);
  const boundaryCongress = integerEnv('DISTRICT_BOUNDARY_CONGRESS', 119);
  const dataset = 'acs/acs5';
  const variables = ['NAME', ...METRICS.flatMap(([, estimate, margin]) => [estimate, margin])];
  const url = new URL(`https://api.census.gov/data/${year}/acs/acs5`);
  url.searchParams.set('get', variables.join(','));
  url.searchParams.set('for', 'congressional district:*');
  url.searchParams.set('in', 'state:*');
  if (process.env.CENSUS_API_KEY?.trim())
    url.searchParams.set('key', process.env.CENSUS_API_KEY.trim());

  const response = await fetch(url);
  if (!response.ok) throw new Error(`ACS request failed (${response.status})`);
  const data = (await response.json()) as string[][];
  const header = data[0] ?? [];
  const index = new Map(header.map((name, i) => [name, i] as const));
  const facts: EconomicFactInput[] = [];

  for (const row of data.slice(1)) {
    const stateFips = row[index.get('state') ?? -1];
    const state = FIPS_TO_STATE[stateFips ?? ''];
    const districtCode = row[index.get('congressional district') ?? -1];
    if (!state || !districtCode) continue;
    for (const [metricKey, estimateVariable, marginVariable, unit] of METRICS) {
      facts.push({
        source: 'acs',
        dataset,
        sourceYear: year,
        state,
        districtCode,
        boundaryCongress,
        metricKey,
        metricValue: finite(row[index.get(estimateVariable) ?? -1]),
        marginOfError: finite(row[index.get(marginVariable) ?? -1]),
        unit,
        sourceRecordId: `${stateFips}:${districtCode}:${estimateVariable}`,
        sourceUrl: url.toString(),
        observedAt: new Date(`${year}-01-01T00:00:00.000Z`),
        metadata: {
          censusName: row[index.get('NAME') ?? -1] ?? null,
          estimateVariable,
          marginVariable,
          annualDataset: true,
        },
      });
    }
    const labor = finite(row[index.get('B23025_003E') ?? -1]);
    const unemployed = finite(row[index.get('B23025_005E') ?? -1]);
    facts.push({
      source: 'acs',
      dataset,
      sourceYear: year,
      state,
      districtCode,
      boundaryCongress,
      metricKey: 'unemployment_rate_percent',
      metricValue:
        labor != null && labor > 0 && unemployed != null ? (unemployed / labor) * 100 : null,
      unit: 'percent',
      sourceRecordId: `${stateFips}:${districtCode}:derived-unemployment-rate`,
      sourceUrl: url.toString(),
      observedAt: new Date(`${year}-01-01T00:00:00.000Z`),
      metadata: {
        numerator: 'B23025_005E',
        denominator: 'B23025_003E',
        derived: true,
        annualDataset: true,
      },
    });
  }

  const result = await writeEconomicFacts(
    prisma,
    {
      source: 'acs',
      dataset,
      sourceYear: year,
      boundaryCongress,
      dryRun: envDryRun(),
      metadata: { requestUrl: url.toString(), variableCount: variables.length },
    },
    facts,
  );
  console.log(JSON.stringify(result));
  return result;
}

export async function main(): Promise<void> {
  await runEconomicSync('acs', run);
}

if (
  /sync-district-economic-acs(\.[cm]?[tj]s)?$/.test((process.argv[1] ?? '').replace(/\\/g, '/'))
) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
