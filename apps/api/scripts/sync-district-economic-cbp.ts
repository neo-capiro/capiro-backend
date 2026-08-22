import { PrismaClient } from '@prisma/client';
import {
  envDryRun,
  writeEconomicFacts,
  type EconomicFactInput,
} from './district-economic-source.js';

const FIPS_TO_STATE: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP',
  '72': 'PR', '78': 'VI',
};

function integerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function finite(value: unknown): number | null {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchCode(
  year: number,
  code: string,
  boundaryCongress: number,
): Promise<EconomicFactInput[]> {
  const dataset = 'cbp';
  // The Census County Business Patterns (CBP) API variable is NAICS2017 for
  // every vintage year currently published (verified 2018-2023 against
  // https://api.census.gov/data/<year>/cbp/variables.json -- CBP has never
  // exposed a NAICS2022 variable, unlike some other Census datasets). A
  // year>=2022 branch that requested NAICS2022 caused every CBP dry-run to
  // fail with HTTP 400 "unknown variable 'NAICS2022'" for every configured
  // NAICS code. Always request NAICS2017.
  const naicsVariable = 'NAICS2017';
  const labelVariable = `${naicsVariable}_LABEL`;
  const url = new URL(`https://api.census.gov/data/${year}/cbp`);
  url.searchParams.set(
    'get',
    ['NAME', naicsVariable, labelVariable, 'ESTAB', 'EMP', 'PAYANN', 'PAYQTR1'].join(','),
  );
  url.searchParams.set('for', 'congressional district:*');
  url.searchParams.set('in', 'state:*');
  url.searchParams.set(naicsVariable, code);
  if (process.env.CENSUS_API_KEY?.trim()) url.searchParams.set('key', process.env.CENSUS_API_KEY.trim());

  const response = await fetch(url);
  if (!response.ok) throw new Error(`CBP ${code} request failed (${response.status})`);
  const data = (await response.json()) as string[][];
  const header = data[0] ?? [];
  const index = new Map(header.map((name, i) => [name, i] as const));
  const facts: EconomicFactInput[] = [];

  for (const row of data.slice(1)) {
    const stateFips = row[index.get('state') ?? -1];
    const state = FIPS_TO_STATE[stateFips];
    const districtCode = row[index.get('congressional district') ?? -1];
    if (!state || !districtCode) continue;
    const actualCode = row[index.get(naicsVariable) ?? -1] || code;
    const label = row[index.get(labelVariable) ?? -1] ?? null;
    const base = {
      source: 'cbp' as const,
      dataset,
      sourceYear: year,
      state,
      districtCode,
      boundaryCongress,
      naicsCode: actualCode,
      sourceUrl: url.toString(),
      observedAt: new Date(`${year}-01-01T00:00:00.000Z`),
      metadata: { naicsLabel: label, annualDataset: true },
    };
    facts.push(
      {
        ...base,
        metricKey: 'establishments',
        metricValue: finite(row[index.get('ESTAB') ?? -1]),
        unit: 'establishments',
        sourceRecordId: `${stateFips}:${districtCode}:${actualCode}:ESTAB`,
      },
      {
        ...base,
        metricKey: 'employment',
        metricValue: finite(row[index.get('EMP') ?? -1]),
        unit: 'people',
        sourceRecordId: `${stateFips}:${districtCode}:${actualCode}:EMP`,
      },
      {
        ...base,
        metricKey: 'annual_payroll_usd',
        metricValue:
          finite(row[index.get('PAYANN') ?? -1]) == null
            ? null
            : finite(row[index.get('PAYANN') ?? -1])! * 1_000,
        unit: 'USD',
        sourceRecordId: `${stateFips}:${districtCode}:${actualCode}:PAYANN`,
        metadata: { ...base.metadata, sourceUnit: 'thousand_usd' },
      },
      {
        ...base,
        metricKey: 'q1_payroll_usd',
        metricValue:
          finite(row[index.get('PAYQTR1') ?? -1]) == null
            ? null
            : finite(row[index.get('PAYQTR1') ?? -1])! * 1_000,
        unit: 'USD',
        sourceRecordId: `${stateFips}:${districtCode}:${actualCode}:PAYQTR1`,
        metadata: { ...base.metadata, sourceUnit: 'thousand_usd' },
      },
    );
  }
  return facts;
}

async function main(): Promise<void> {
  const year = integerEnv('CBP_YEAR', 2023);
  const boundaryCongress = integerEnv('DISTRICT_BOUNDARY_CONGRESS', 119);
  const codes = (process.env.CBP_NAICS_CODES ?? '00,31-33,48-49,54,61')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
  const facts: EconomicFactInput[] = [];
  const failedCodes: string[] = [];

  for (const code of codes) {
    try {
      facts.push(...(await fetchCode(year, code, boundaryCongress)));
    } catch (error) {
      if (code === '00') throw error;
      failedCodes.push(code);
      // Deliberately invalid state: the shared writer rejects this row and
      // records success_with_errors instead of silently claiming full coverage.
      facts.push({
        source: 'cbp',
        dataset: 'cbp',
        sourceYear: year,
        state: '',
        districtCode: '',
        boundaryCongress,
        metricKey: `failed_naics_${code}`,
        metricValue: null,
        unit: null,
        naicsCode: code,
        metadata: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  const prisma = new PrismaClient();
  try {
    const result = await writeEconomicFacts(
      prisma,
      {
        source: 'cbp',
        dataset: 'cbp',
        sourceYear: year,
        boundaryCongress,
        dryRun: envDryRun(),
        metadata: { configuredNaicsCodes: codes, failedCodes },
      },
      facts,
    );
    console.log(JSON.stringify({ ...result, failedCodes }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
