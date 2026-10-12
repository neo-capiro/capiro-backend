/**
 * Sync Census ACS 5-Year data by congressional district.
 *
 *   pnpm --filter @capiro/api sync:census
 *
 * Source: api.census.gov/data/2022/acs/acs5
 * Auth: Free API key. Key in env: CENSUS_API_KEY
 *
 * Fetches demographics per congressional district: population, income,
 * education, poverty, veterans, unemployment, top industries.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

const CENSUS_API_KEY = process.env.CENSUS_API_KEY ?? '';
const ACS_YEAR = 2022; // Latest ACS 5-year vintage
const DELAY_MS = 200;

// FIPS to state code mapping (abbreviated, full 50 states + DC)
const FIPS_TO_STATE: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT',
  '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL',
  '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD',
  '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
  '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND',
  '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV',
  '55': 'WI', '56': 'WY', '72': 'PR',
};

// ACS variables we want
const VARIABLES = [
  'B01001_001E', // Total population
  'B19013_001E', // Median household income
  'B01002_001E', // Median age
  'B15003_022E', // Bachelor's degree
  'B15003_023E', // Master's degree
  'B15003_024E', // Professional degree
  'B15003_025E', // Doctorate degree
  'B15003_001E', // Total pop 25+ (education denominator)
  'B17001_002E', // Below poverty level
  'B17001_001E', // Poverty universe total
  'B21001_002E', // Veteran population
  'B21001_001E', // Veteran universe total
  'B27010_001E', // Health insurance universe
  'B27010_017E', // No health insurance (19-64)
  'B23025_002E', // In labor force
  'B23025_005E', // Unemployed
].join(',');

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return (await resp.json()) as T;
  } catch (err) {
    console.warn(`GET ${url}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function num(v: string | null): number | null {
  if (!v || v === '-666666666' || v === 'null') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function pct(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10; // one decimal
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-census.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[census-sync] starting');

  if (!CENSUS_API_KEY) throw new Error('CENSUS_API_KEY env var is required');

  try {
    // Fetch all congressional districts
    const url = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5?get=NAME,${VARIABLES}&for=congressional%20district:*&in=state:*&key=${CENSUS_API_KEY}`;
    const data = await fetchJson<string[][]>(url);

    if (!data || data.length < 2) {
      throw new Error('No data returned from Census API');
    }

    const headers = data[0];
    const rows = data.slice(1);
    console.log(`[census-sync] fetched ${rows.length} congressional districts`);

    let total = 0;
    for (const row of rows) {
      const record: Record<string, string> = {};
      headers.forEach((h, i) => { record[h] = row[i]; });

      const stateFips = record['state'];
      const district = record['congressional district'];
      const stateCode = FIPS_TO_STATE[stateFips];
      if (!stateCode) continue;

      const districtLabel = district === '00' ? 'AL' : district;
      const id = `119-${stateCode}-${districtLabel}`;

      const totalPop = num(record['B01001_001E']);
      const bachelors = num(record['B15003_022E']);
      const masters = num(record['B15003_023E']);
      const professional = num(record['B15003_024E']);
      const doctorate = num(record['B15003_025E']);
      const eduTotal = num(record['B15003_001E']);
      const bachelorPlus = (bachelors ?? 0) + (masters ?? 0) + (professional ?? 0) + (doctorate ?? 0);
      const povertyBelow = num(record['B17001_002E']);
      const povertyTotal = num(record['B17001_001E']);
      const vetPop = num(record['B21001_002E']);
      const vetTotal = num(record['B21001_001E']);
      const uninsured = num(record['B27010_017E']);
      const insuredTotal = num(record['B27010_001E']);
      const laborForce = num(record['B23025_002E']);
      const unemployed = num(record['B23025_005E']);

      await prisma.censusDistrict.upsert({
        where: { id },
        update: {
          totalPopulation: totalPop,
          medianHouseholdIncome: num(record['B19013_001E']),
          medianAge: num(record['B01002_001E']) ? parseFloat(record['B01002_001E']) : null,
          percentBachelorPlus: pct(bachelorPlus, eduTotal),
          percentPoverty: pct(povertyBelow, povertyTotal),
          percentVeteran: pct(vetPop, vetTotal),
          percentUninsured: pct(uninsured, insuredTotal),
          laborForceSize: laborForce,
          unemploymentRate: pct(unemployed, laborForce),
          dataYear: ACS_YEAR,
          syncedAt: new Date(),
        },
        create: {
          id,
          congress: 119,
          state: stateCode,
          stateFips,
          district: districtLabel,
          totalPopulation: totalPop,
          medianHouseholdIncome: num(record['B19013_001E']),
          medianAge: num(record['B01002_001E']) ? parseFloat(record['B01002_001E']) : null,
          percentBachelorPlus: pct(bachelorPlus, eduTotal),
          percentPoverty: pct(povertyBelow, povertyTotal),
          percentVeteran: pct(vetPop, vetTotal),
          percentUninsured: pct(uninsured, insuredTotal),
          laborForceSize: laborForce,
          unemploymentRate: pct(unemployed, laborForce),
          topIndustries: [],
          dataYear: ACS_YEAR,
        },
      });
      total++;
    }

    console.log(`[census-sync] upserted ${total} districts`);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[census-sync] DONE in ${elapsed}s`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
main().catch((err) => {
  console.error('[census-sync] FAILED', err);
  process.exit(1);
});
}
