/**
 * Sync BLS (Bureau of Labor Statistics) economic data.
 *
 *   pnpm --filter @capiro/api sync:bls
 *
 * Source: api.bls.gov/publicAPI/v2/ (with key) or v1/ (no key, 25 req/day)
 * Auth: Optional API key (500 req/day for v2). Key in env: BLS_API_KEY
 *       Falls back to v1 (no key) if key is missing or invalid.
 *
 * Fetches key lobbying-relevant series: CPI, unemployment, employment by industry.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

const BLS_BASE = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const BLS_API_KEY = process.env.BLS_API_KEY ?? '';
const DELAY_MS = 500;

// Key series for lobbying intelligence
const SERIES = [
  { id: 'CUUR0000SA0', title: 'CPI - All Urban Consumers (U.S. city average)', survey: 'CPI', period: 'Monthly' },
  { id: 'LNS14000000', title: 'Unemployment Rate (seasonally adjusted)', survey: 'CPS', period: 'Monthly' },
  { id: 'CES0000000001', title: 'Total Nonfarm Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES0500000001', title: 'Total Private Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES1000000001', title: 'Mining and Logging Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES2000000001', title: 'Construction Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES3000000001', title: 'Manufacturing Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES4000000001', title: 'Trade, Transportation, Utilities Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES5000000001', title: 'Information Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES5500000001', title: 'Financial Activities Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES6000000001', title: 'Professional and Business Services Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES6500000001', title: 'Education and Health Services Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES7000000001', title: 'Leisure and Hospitality Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES9000000001', title: 'Government Employment', survey: 'CES', period: 'Monthly' },
  { id: 'CES3100000001', title: 'Durable Goods Manufacturing', survey: 'CES', period: 'Monthly' },
  { id: 'CES3200000001', title: 'Nondurable Goods Manufacturing', survey: 'CES', period: 'Monthly' },
  { id: 'PCU--', title: 'PPI - All Commodities', survey: 'PPI', period: 'Monthly' },
  { id: 'EIUIR', title: 'Import Price Index - All Commodities', survey: 'EI', period: 'Monthly' },
];

interface BlsResponse {
  status: string;
  Results: {
    series: {
      seriesID: string;
      data: {
        year: string;
        period: string;
        value: string;
        footnotes: { code: string; text: string }[];
      }[];
    }[];
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-bls.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[bls-sync] starting');

  if (!BLS_API_KEY) {
    throw new Error('BLS_API_KEY env var is required');
  }

  try {
    const currentYear = new Date().getFullYear();
    const startYear = currentYear - 5;

    // BLS v2 allows up to 50 series per request
    // Process in batches of 25
    for (let i = 0; i < SERIES.length; i += 25) {
      const batch = SERIES.slice(i, i + 25);
      const seriesIds = batch.map((s) => s.id);

      const resp = await fetch(BLS_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seriesid: seriesIds,
          startyear: String(startYear),
          endyear: String(currentYear),
          registrationkey: BLS_API_KEY,
        }),
      });

      if (!resp.ok) {
        console.warn(`[bls-sync] API error: ${resp.status}`);
        continue;
      }

      const data = (await resp.json()) as BlsResponse;
      if (data.status !== 'REQUEST_SUCCEEDED') {
        console.warn(`[bls-sync] API status: ${data.status}`);
        continue;
      }

      for (const series of data.Results.series) {
        const meta = batch.find((s) => s.id === series.seriesID);
        if (!meta) continue;

        // Upsert series metadata
        await prisma.blsSeries.upsert({
          where: { id: series.seriesID },
          update: { title: meta.title, surveyName: meta.survey, periodType: meta.period, syncedAt: new Date() },
          create: { id: series.seriesID, title: meta.title, surveyName: meta.survey, periodType: meta.period },
        });

        // Upsert data points
        for (const dp of series.data) {
          const value = parseFloat(dp.value);
          if (isNaN(value)) continue;

          await prisma.blsDataPoint.upsert({
            where: {
              seriesId_year_period: {
                seriesId: series.seriesID,
                year: parseInt(dp.year),
                period: dp.period,
              },
            },
            update: { value, footnotes: dp.footnotes?.map((f) => f.text).filter(Boolean) ?? [] },
            create: {
              seriesId: series.seriesID,
              year: parseInt(dp.year),
              period: dp.period,
              value,
              footnotes: dp.footnotes?.map((f) => f.text).filter(Boolean) ?? [],
            },
          });
        }

        console.log(`[bls-sync] ${meta.title}: ${series.data.length} data points`);
      }

      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[bls-sync] DONE in ${elapsed}s`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
main().catch((err) => {
  console.error('[bls-sync] FAILED', err);
  process.exit(1);
});
}
