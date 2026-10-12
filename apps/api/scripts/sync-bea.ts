/**
 * Sync BEA (Bureau of Economic Analysis) GDP and industry data.
 *   pnpm --filter @capiro/api sync:bea
 * Source: apps.bea.gov/api/data/
 * Auth: Free API key. Key in env: BEA_API_KEY
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
dotenvConfig();

const BEA_BASE = 'https://apps.bea.gov/api/data';
const BEA_API_KEY = process.env.BEA_API_KEY ?? '';

interface BeaRow { LineDescription: string; LineNumber: string; SeriesCode: string; TimePeriod: string; DataValue: string; UNIT_MULT: string; }
interface BeaResponse { BEAAPI: { Results: { Data?: BeaRow[]; Error?: any } } }

async function fetchBea(params: Record<string, string>): Promise<BeaRow[]> {
  const url = new URL(BEA_BASE);
  url.searchParams.set('UserID', BEA_API_KEY);
  url.searchParams.set('method', 'GetData');
  url.searchParams.set('ResultFormat', 'JSON');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`BEA HTTP ${resp.status}`);
  const data = (await resp.json()) as BeaResponse;
  if (data.BEAAPI.Results.Error) {
    const err = data.BEAAPI.Results.Error;
    const msg = err.ErrorDetail?.Description || err.APIErrorDescription || JSON.stringify(err);
    throw new Error(msg);
  }
  return data.BEAAPI.Results.Data ?? [];
}

const TABLES = [
  { dataset: 'NIPA', table: 'T10101', name: 'GDP Percent Change', years: '2020,2021,2022,2023,2024,2025', freq: 'Q' },
  { dataset: 'NIPA', table: 'T10105', name: 'GDP by Industry', years: '2020,2021,2022,2023,2024,2025', freq: 'Q' },
  { dataset: 'NIPA', table: 'T20100', name: 'Personal Income', years: '2022,2023,2024,2025', freq: 'Q' },
  { dataset: 'NIPA', table: 'T30100', name: 'Government Receipts & Expenditures', years: '2022,2023,2024,2025', freq: 'Q' },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-bea.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[bea-sync] starting');
  if (!BEA_API_KEY) throw new Error('BEA_API_KEY env var is required');

  try {
    let total = 0;
    for (const tbl of TABLES) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const rows = await fetchBea({
          DatasetName: tbl.dataset, TableName: tbl.table,
          Frequency: tbl.freq, Year: tbl.years,
        });
        for (const row of rows) {
          const val = parseFloat(row.DataValue?.replace(/,/g, ''));
          if (isNaN(val)) continue;
          const period = row.TimePeriod;
          const year = parseInt(period.slice(0, 4));
          const q = period.length > 4 ? period.slice(4) : 'Annual';
          await (prisma as any).beaData.upsert({
            where: { datasetName_tableName_seriesCode_year_period_geoFips: {
              datasetName: tbl.dataset, tableName: tbl.table,
              seriesCode: row.SeriesCode || row.LineNumber, year, period: q, geoFips: '',
            }},
            update: { value: val, description: row.LineDescription, syncedAt: new Date() },
            create: {
              datasetName: tbl.dataset, tableName: tbl.table,
              lineNumber: parseInt(row.LineNumber) || null,
              seriesCode: row.SeriesCode || row.LineNumber,
              description: row.LineDescription, year, period: q, value: val,
              units: 'See BEA table', geoFips: '',
            },
          });
          total++;
        }
        console.log(`[bea-sync] ${tbl.name}: ${rows.length} rows`);
      } catch (err) {
        console.warn(`[bea-sync] ${tbl.name} failed: ${(err as Error).message}`);
      }
    }
    console.log(`[bea-sync] total: ${total} data points`);
    console.log(`[bea-sync] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally { await prisma.$disconnect(); }
}

if (require.main === module) {
main().catch((err) => { console.error('[bea-sync] FAILED', err); process.exit(1); });
}