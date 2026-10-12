/**
 * reconcile-stale-pes.ts
 *
 *   tsx scripts/reconcile-stale-pes.ts            # DRY RUN (counts + samples)
 *   tsx scripts/reconcile-stale-pes.ts --commit   # set retired_at
 *   flags: --limit=N (cap retires this run; 0 = all)
 *
 * Soft-retires Program Elements that exist ONLY because of the old DoW spreadsheet
 * (source='stanford_pe_directory_jan2026') AND carry no live signal. A PE still
 * bearing that source was never re-asserted by an authoritative source (the J-book
 * writer relabels source on every PE it touches). We KEEP any such PE that has a
 * real signal — a year row, federal award, bill reference, watch, client capability,
 * J-book citation, project, or a NON-superseded person pointing at it — so
 * real-but-uncovered PEs (e.g. procurement BLIs) survive. NEVER a hard delete
 * (watches / awards / bills reference pe_code with no FK). Reversible.
 *
 * Run reconcile-personnel-supersede FIRST: a PE pointed at only by superseded
 * people then scores 0 on the person signal and becomes retire-eligible.
 *
 * The signal set here is identical to diag-stale-directory, so its "wouldRetire"
 * equals what this commits.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { classifyPeRetire } from '../src/program-element/pe-staleness.js';

dotenvConfig();

const COMMIT = process.argv.includes('--commit');

function numArg(name: string, def: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return def;
  const v = Number(hit.split('=')[1]);
  return Number.isFinite(v) ? v : def;
}

const RETIRE_REASON =
  'old DoW spreadsheet PE (stanford_pe_directory_jan2026) with no live signal; never re-asserted by a J-book / authoritative source';

interface SignalRow {
  peCode: string;
  hasYear: boolean;
  hasAward: boolean;
  hasBill: boolean;
  hasWatch: boolean;
  hasCap: boolean;
  hasCitation: boolean;
  hasProject: boolean;
  hasActivePerson: boolean;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/reconcile-stale-pes.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const limit = numArg('limit', 0);
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const rows = await prisma.$queryRaw<SignalRow[]>(Prisma.sql`
      SELECT
        p.pe_code AS "peCode",
        EXISTS (SELECT 1 FROM program_element_year y WHERE y.pe_code = p.pe_code) AS "hasYear",
        EXISTS (SELECT 1 FROM federal_award fa WHERE fa.pe_code = p.pe_code) AS "hasAward",
        EXISTS (SELECT 1 FROM congress_bill b WHERE p.pe_code = ANY(b.pe_codes)) AS "hasBill",
        EXISTS (SELECT 1 FROM program_element_watch w WHERE w.pe_code = p.pe_code) AS "hasWatch",
        EXISTS (SELECT 1 FROM client_capabilities cc WHERE cc.pe_number = p.pe_code) AS "hasCap",
        EXISTS (SELECT 1 FROM program_element_source s WHERE s.pe_code = p.pe_code) AS "hasCitation",
        EXISTS (SELECT 1 FROM program_element_project pr WHERE pr.pe_code = p.pe_code) AS "hasProject",
        EXISTS (
          SELECT 1 FROM acquisition_personnel ap
          WHERE ap.superseded_at IS NULL
            AND (ap.pe_primary = p.pe_code OR p.pe_code = ANY(ap.pe_secondary))
        ) AS "hasActivePerson"
      FROM program_element p
      WHERE p.source = 'stanford_pe_directory_jan2026' AND p.retired_at IS NULL
    `);

    const toRetire: string[] = [];
    let keep = 0;
    for (const r of rows) {
      const decision = classifyPeRetire({
        source: 'stanford_pe_directory_jan2026',
        retiredAt: null,
        linkedActivePersonCount: r.hasActivePerson ? 1 : 0,
        yearRowCount: r.hasYear ? 1 : 0,
        awardCount: r.hasAward ? 1 : 0,
        billCount: r.hasBill ? 1 : 0,
        watchCount: r.hasWatch ? 1 : 0,
        capabilityCount: r.hasCap ? 1 : 0,
        procurementLineCount: 0, // not in the diag signal set; see header note
        jbookCitationCount: r.hasCitation ? 1 : 0,
        projectCount: r.hasProject ? 1 : 0,
      });
      if (decision.action === 'retire') toRetire.push(r.peCode);
      else if (decision.action === 'keep') keep += 1;
    }

    const capped = limit > 0 ? toRetire.slice(0, limit) : toRetire;

    let retired = 0;
    if (COMMIT && capped.length > 0) {
      const now = new Date();
      const BATCH = 500;
      for (let i = 0; i < capped.length; i += BATCH) {
        const codes = capped.slice(i, i + BATCH);
        const res = await prisma.programElement.updateMany({
          where: { peCode: { in: codes }, retiredAt: null },
          data: { retiredAt: now, retiredReason: RETIRE_REASON },
        });
        retired += res.count;
      }
    }

    console.log(
      JSON.stringify(
        {
          mode: COMMIT ? 'COMMIT' : 'DRY_RUN',
          oldSpreadsheetActive: rows.length,
          keepRealButUncovered: keep,
          wouldRetire: toRetire.length,
          capApplied: limit > 0 ? limit : null,
          retired: COMMIT ? retired : 0,
          sampleCodes: capped.slice(0, 20),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((err) => {
  console.error('[reconcile-stale-pes] FAILED', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
}
