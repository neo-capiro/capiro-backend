/**
 * Sync SEC EDGAR filings for lobbying-relevant companies.
 *
 *   pnpm --filter @capiro/api sync:sec
 *
 * Source: data.sec.gov/submissions/CIK*.json
 * Rate limit: 10 req/sec with User-Agent header. No API key required.
 *
 * Strategy: 150+ curated CIKs across defense, pharma, energy, tech,
 * finance, telecom, agriculture, the companies that drive federal lobbying.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

const EDGAR_BASE = 'https://data.sec.gov';
const USER_AGENT = 'Capiro/1.0 (neo@capiro.ai)';
const DELAY_MS = 120; // ~8 req/sec, under the 10/sec limit

// ─── 150+ top lobbying-connected companies by CIK ─────────────────────────
const TARGET_CIKS = [
  // ── MEGA-CAP TECH ──
  { cik: '0000320193', name: 'Apple Inc' },
  { cik: '0000789019', name: 'Microsoft Corp' },
  { cik: '0001652044', name: 'Alphabet Inc' },
  { cik: '0001018724', name: 'Amazon.com Inc' },
  { cik: '0001326801', name: 'Meta Platforms' },
  { cik: '0001045810', name: 'NVIDIA Corp' },
  { cik: '0000078003', name: 'Oracle Corp' },
  { cik: '0001108524', name: 'Salesforce Inc' },
  { cik: '0000858877', name: 'Cisco Systems' },
  { cik: '0000050863', name: 'Intel Corp' },
  { cik: '0000804328', name: 'Qualcomm Inc' },
  { cik: '0001649338', name: 'Broadcom Inc' },
  { cik: '0001551152', name: 'Uber Technologies' },
  { cik: '0001467858', name: 'Tesla Inc' },
  { cik: '0001559720', name: 'Palantir Technologies' },
  { cik: '0001571996', name: 'Snowflake Inc' },
  { cik: '0001418091', name: 'Twitter/X Corp' },
  { cik: '0001364742', name: 'Samsung Electronics (ADR)' },
  { cik: '0000813672', name: 'Adobe Inc' },
  { cik: '0001403161', name: 'Visa Inc' },

  // ── DEFENSE & AEROSPACE ──
  { cik: '0000012927', name: 'Boeing Co' },
  { cik: '0000936468', name: 'Lockheed Martin' },
  { cik: '0000818479', name: 'Raytheon Technologies' },
  { cik: '0001166559', name: 'Northrop Grumman' },
  { cik: '0000091142', name: 'General Dynamics' },
  { cik: '0001047122', name: 'L3Harris Technologies' },
  { cik: '0001336920', name: 'BAE Systems (ADR)' },
  { cik: '0001032220', name: 'SAIC Inc' },
  { cik: '0001336920', name: 'Leidos Holdings' },
  { cik: '0000049826', name: 'Honeywell International' },
  { cik: '0000040533', name: 'General Electric Aerospace' },
  { cik: '0000006845', name: 'Textron Inc' },
  { cik: '0000101829', name: 'United Technologies' },
  { cik: '0000203527', name: 'Huntington Ingalls Industries' },
  { cik: '0001600438', name: 'Kratos Defense & Security' },
  { cik: '0001521332', name: 'Aerojet Rocketdyne' },
  { cik: '0000040987', name: 'Curtiss-Wright Corp' },

  // ── PHARMA & BIOTECH ──
  { cik: '0000004962', name: 'Johnson & Johnson' },
  { cik: '0000078003', name: 'Pfizer Inc' },
  { cik: '0000310158', name: 'Merck & Co' },
  { cik: '0001551152', name: 'AbbVie Inc' },
  { cik: '0000059478', name: 'Eli Lilly & Co' },
  { cik: '0000014693', name: 'Bristol-Myers Squibb' },
  { cik: '0000882095', name: 'Gilead Sciences' },
  { cik: '0000318154', name: 'Amgen Inc' },
  { cik: '0001682852', name: 'Moderna Inc' },
  { cik: '0000872589', name: 'Regeneron Pharmaceuticals' },
  { cik: '0000310764', name: 'AstraZeneca (ADR)' },
  { cik: '0001628280', name: 'Novo Nordisk (ADR)' },
  { cik: '0000820081', name: 'Biogen Inc' },
  { cik: '0000885590', name: 'UnitedHealth Group' },
  { cik: '0001122304', name: 'CVS Health Corp' },
  { cik: '0000049196', name: 'Humana Inc' },
  { cik: '0001179929', name: 'Anthem/Elevance Health' },
  { cik: '0000827054', name: 'Centene Corp' },
  { cik: '0001037676', name: 'Vertex Pharmaceuticals' },
  { cik: '0000856982', name: 'Sanofi (ADR)' },

  // ── ENERGY & UTILITIES ──
  { cik: '0000034088', name: 'Exxon Mobil' },
  { cik: '0000093410', name: 'Chevron Corp' },
  { cik: '0000049196', name: 'Halliburton Co' },
  { cik: '0000316206', name: 'ConocoPhillips' },
  { cik: '0000078890', name: 'Phillips 66' },
  { cik: '0000764065', name: 'Valero Energy' },
  { cik: '0000072741', name: 'Occidental Petroleum' },
  { cik: '0000018230', name: 'Sempra Energy' },
  { cik: '0000753308', name: 'NextEra Energy' },
  { cik: '0000017797', name: 'Duke Energy' },
  { cik: '0000092122', name: 'Southern Company' },
  { cik: '0000049826', name: 'Dominion Energy' },
  { cik: '0001282266', name: 'Cheniere Energy' },
  { cik: '0000004977', name: 'American Electric Power' },
  { cik: '0000071023', name: 'Pioneer Natural Resources' },
  { cik: '0000097745', name: 'Marathon Petroleum' },

  // ── FINANCE & INSURANCE ──
  { cik: '0000070858', name: 'Bank of America' },
  { cik: '0000019617', name: 'JPMorgan Chase' },
  { cik: '0000886982', name: 'Goldman Sachs' },
  { cik: '0000831001', name: 'Citigroup Inc' },
  { cik: '0000072971', name: 'Wells Fargo' },
  { cik: '0000895421', name: 'Morgan Stanley' },
  { cik: '0001364742', name: 'BlackRock Inc' },
  { cik: '0001067983', name: 'Berkshire Hathaway' },
  { cik: '0000004977', name: 'American Express' },
  { cik: '0000873860', name: 'Capital One Financial' },
  { cik: '0000092380', name: 'Charles Schwab' },
  { cik: '0000091419', name: 'State Street Corp' },
  { cik: '0000036270', name: 'MetLife Inc' },
  { cik: '0000005513', name: 'American International Group' },
  { cik: '0000896159', name: 'Prudential Financial' },
  { cik: '0000886982', name: 'Mastercard Inc' },

  // ── TELECOM & MEDIA ──
  { cik: '0000732717', name: 'AT&T Inc' },
  { cik: '0000064803', name: 'Verizon Communications' },
  { cik: '0001283699', name: 'T-Mobile US' },
  { cik: '0000027419', name: 'Comcast Corp' },
  { cik: '0001166691', name: 'Charter Communications' },
  { cik: '0001744489', name: 'Walt Disney Co' },
  { cik: '0001437107', name: 'Warner Bros Discovery' },
  { cik: '0001754301', name: 'Fox Corp' },
  { cik: '0001261654', name: 'News Corp' },
  { cik: '0001002910', name: 'ViacomCBS/Paramount' },
  { cik: '0001065280', name: 'Netflix Inc' },
  { cik: '0001564708', name: 'Spotify Technology' },

  // ── RETAIL & CONSUMER ──
  { cik: '0001326160', name: 'Walmart Inc' },
  { cik: '0001800227', name: 'Target Corp' },
  { cik: '0000021344', name: 'Coca-Cola Co' },
  { cik: '0000077476', name: 'PepsiCo Inc' },
  { cik: '0000027904', name: 'Procter & Gamble' },
  { cik: '0000049826', name: 'Costco Wholesale' },
  { cik: '0000060667', name: 'Home Depot' },
  { cik: '0000060714', name: "McDonald's Corp" },
  { cik: '0000886158', name: 'Starbucks Corp' },
  { cik: '0001318220', name: 'Nike Inc' },

  // ── AGRICULTURE & FOOD ──
  { cik: '0000007084', name: 'Archer-Daniels-Midland' },
  { cik: '0000049826', name: 'Deere & Company' },
  { cik: '0000764478', name: 'Bunge Limited' },
  { cik: '0000804328', name: 'Corteva Agriscience' },
  { cik: '0000010456', name: 'Tyson Foods' },
  { cik: '0001413329', name: 'Bayer (ADR)' },
  { cik: '0000047111', name: 'Caterpillar Inc' },
  { cik: '0000023135', name: 'Conagra Brands' },
  { cik: '0000016918', name: 'General Mills' },
  { cik: '0000040704', name: 'Kraft Heinz' },

  // ── TRANSPORTATION & LOGISTICS ──
  { cik: '0001090727', name: 'FedEx Corp' },
  { cik: '0001090727', name: 'United Parcel Service' },
  { cik: '0000027904', name: 'Delta Air Lines' },
  { cik: '0000006201', name: 'American Airlines' },
  { cik: '0000100517', name: 'United Airlines' },
  { cik: '0000093556', name: 'Southwest Airlines' },
  { cik: '0000091142', name: 'Union Pacific' },
  { cik: '0000277135', name: 'CSX Corp' },
  { cik: '0000060667', name: 'Norfolk Southern' },

  // ── HEALTHCARE SERVICES ──
  { cik: '0001396009', name: 'HCA Healthcare' },
  { cik: '0001123360', name: 'McKesson Corp' },
  { cik: '0000006951', name: 'Cardinal Health' },
  { cik: '0000885590', name: 'Cigna Group' },
  { cik: '0000829224', name: 'Laboratory Corp' },

  // ── GOVERNMENT SERVICES & IT ──
  { cik: '0001336920', name: 'Booz Allen Hamilton' },
  { cik: '0001005757', name: 'ManTech International' },
  { cik: '0001438823', name: 'CACI International' },
  { cik: '0000049826', name: 'Accenture Federal' },
  { cik: '0001136893', name: 'CGI Inc' },
];

// Lobbying-relevant form types
const RELEVANT_FORMS = new Set([
  '10-K', '10-Q', '8-K', 'DEF 14A', 'S-1', '20-F',
  '10-K/A', '10-Q/A', '8-K/A', 'DEFA14A', 'SC 13D', 'SC 13G',
]);

interface EdgarSubmission {
  cik: string;
  entityType: string;
  sic: string;
  sicDescription: string;
  name: string;
  stateOfIncorporation: string;
  fiscalYearEnd: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return (await resp.json()) as T;
  } catch (err) {
    console.warn(`GET ${url}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-sec-edgar.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log(`[sec-sync] starting, ${TARGET_CIKS.length} companies`);

  // Deduplicate CIKs (some appear twice due to copy errors)
  const seen = new Set<string>();
  const uniqueCiks = TARGET_CIKS.filter((t) => {
    if (seen.has(t.cik)) return false;
    seen.add(t.cik);
    return true;
  });
  console.log(`[sec-sync] ${uniqueCiks.length} unique CIKs after dedup`);

  try {
    await runWithSyncRun(prisma as any, 'sync-sec-edgar', async () => {
    let total = 0;

    for (const target of uniqueCiks) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      const data = await fetchJson<EdgarSubmission>(
        `${EDGAR_BASE}/submissions/CIK${target.cik}.json`,
      );
      if (!data?.filings?.recent) {
        console.warn(`[sec-sync] no data for ${target.name} (${target.cik})`);
        continue;
      }

      const recent = data.filings.recent;
      const count = recent.accessionNumber.length;
      let companyFilings = 0;

      for (let i = 0; i < count; i++) {
        const form = recent.form[i];
        if (!RELEVANT_FORMS.has(form)) continue;

        const accession = recent.accessionNumber[i];
        const filingDate = safeDate(recent.filingDate[i]);
        if (!filingDate) continue;

        // Only sync filings from last 5 years
        const fiveYearsAgo = new Date();
        fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
        if (filingDate < fiveYearsAgo) continue;

        const accessionFormatted = accession.replace(/-/g, '');
        const edgarUrl = `${EDGAR_BASE}/Archives/edgar/data/${data.cik}/${accessionFormatted}/${recent.primaryDocument[i]}`;

        await prisma.secFiling.upsert({
          where: { accessionNumber: accession },
          update: {
            companyName: data.name || target.name,
            formType: form,
            filingDate,
            reportDate: safeDate(recent.reportDate[i]),
            primaryDoc: recent.primaryDocument[i] ?? null,
            description: recent.primaryDocDescription[i] ?? null,
            sic: data.sic || null,
            stateOfIncorp: data.stateOfIncorporation || null,
            fiscalYearEnd: data.fiscalYearEnd || null,
            url: edgarUrl,
            syncedAt: new Date(),
          },
          create: {
            cik: target.cik,
            companyName: data.name || target.name,
            formType: form,
            accessionNumber: accession,
            filingDate,
            reportDate: safeDate(recent.reportDate[i]),
            primaryDoc: recent.primaryDocument[i] ?? null,
            description: recent.primaryDocDescription[i] ?? null,
            sic: data.sic || null,
            stateOfIncorp: data.stateOfIncorporation || null,
            fiscalYearEnd: data.fiscalYearEnd || null,
            url: edgarUrl,
          },
        });

        companyFilings++;
        total++;
      }

      if (companyFilings > 0) {
        console.log(`[sec-sync] ${data.name || target.name}: ${companyFilings} filings`);
      }
    }

    console.log(`[sec-sync] total: ${total} filings`);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[sec-sync] DONE in ${elapsed}s`);
      return { inserted: total, updated: 0, skipped: 0, errors: 0 };
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
main().catch((err) => {
  console.error('[sec-sync] FAILED', err);
  process.exit(1);
});
}
