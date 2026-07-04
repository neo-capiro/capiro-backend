/**
 * Step 33 — SAM.gov solicitation personnel sync.
 *
 *   pnpm --filter @capiro/api sync:sam-personnel
 *   tsx scripts/sync-sam-personnel.ts --days 30
 *   SAM_MAX_PAGES=250 tsx scripts/sync-sam-personnel.ts --backfill --since 2025-04-01 --posted-to 2025-06-30
 *
 * Pulls DoD Contract Opportunities from the SAM.gov API (api.sam.gov/opportunities/
 * v2/search), extracts the Contracting Officer / Contract Specialist from the
 * solicitation header (pointOfContact), captures the domain (shown to all) AND the
 * full email (read layer gates that to capiro_admin), attempts PE attribution from
 * the description, and upserts via the personnel writer (source='sam_gov',
 * confidence=0.85). Only public header fields are used; no external enrichment.
 *
 * Backfill: --since / --posted-to bound an explicit window (default = last --days,
 * 30); SAM caps a search's span at ~1yr, so a multi-year backfill walks <=1yr
 * (quarterly) windows. SAM_MAX_PAGES raises the page circuit-breaker (default 50 ->
 * 5,000 rows); a capped window logs a loud CAPPED warning. Idempotent on re-run.
 *
 * Idempotent: writer dedups source mentions by observedAt (the notice postedDate).
 * Requires SAM_GOV_API_KEY (Secrets Manager -> env).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  SamPersonnelExtractorService,
  SAM_SOURCE,
  SAM_CONFIDENCE,
  type SamOpportunity,
} from '../src/acquisition-personnel/extractors/sam-personnel-extractor.service.js';
import { AcquisitionPersonnelWriterService } from '../src/acquisition-personnel/acquisition-personnel-writer.service.js';
import { MatchScorerService } from '../src/acquisition-personnel/matching/match-scorer.service.js';

dotenvConfig();

const SAM_API_KEY = process.env.SAM_GOV_API_KEY ?? '';
const SAM_URL = 'https://api.sam.gov/opportunities/v2/search';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** MM/dd/yyyy (SAM.gov date format). */
function samDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

interface SamSearchResponse {
  totalRecords?: number;
  opportunitiesData?: SamOpportunity[];
  error?: { message?: string };
}

async function fetchPage(
  postedFrom: string,
  postedTo: string,
  offset: number,
  limit: number,
): Promise<SamSearchResponse> {
  const params = new URLSearchParams({
    api_key: SAM_API_KEY,
    postedFrom,
    postedTo,
    limit: String(limit),
    offset: String(offset),
    // Department of Defense organization id (deptname filter also works); we filter
    // again client-side via extractor.isDod for safety.
    deptname: 'DEPARTMENT OF DEFENSE',
  });
  const res = await fetch(`${SAM_URL}?${params.toString()}`);
  const json = (await res.json()) as SamSearchResponse;
  if (!res.ok)
    throw new Error(
      `SAM.gov ${res.status}: ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`,
    );
  return json;
}

async function main(): Promise<void> {
  if (!SAM_API_KEY) throw new Error('SAM_GOV_API_KEY not configured');
  // Window: --since / --posted-to bound an explicit backfill window; else the last
  // --days (default 30). SAM caps a search's span at ~1yr, so a multi-year personnel
  // backfill walks <=1yr (ideally quarterly) windows. Mirrors sync-sam-opportunities.
  const days = Number(arg('days') ?? 30);
  const sinceArg = arg('since');
  const postedToArg = arg('posted-to');
  const backfill = process.argv.includes('--backfill');
  const from = sinceArg ? new Date(sinceArg) : new Date(Date.now() - days * 86400_000);
  const to = postedToArg ? new Date(postedToArg) : new Date();
  const source = 'sam_personnel';

  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const writer = new AcquisitionPersonnelWriterService(prisma, new MatchScorerService(prisma));
  const extractor = new SamPersonnelExtractorService();

  const run = await prisma.syncRun.create({
    data: { source, startedAt: new Date(), status: 'running' },
  });

  let opps = 0;
  let people = 0;
  let inserted = 0;
  let errors = 0;

  try {
    const pes = await prisma.programElement.findMany({ select: { peCode: true } });
    const knownPeCodes = new Set<string>(
      pes.map((p: { peCode: string }) => p.peCode.toUpperCase()),
    );

    const limit = 100;
    let offset = 0;
    // Env-overridable page budget (SAM_MAX_PAGES x 100 rows); raise for dense backfill windows.
    const maxPages = Number(process.env.SAM_MAX_PAGES) || 50;
    let totalRecords: number | undefined;
    let capped = false;
    console.log(
      `[sam-personnel] window ${samDate(from)}..${samDate(to)} maxPages=${maxPages}${backfill ? ' BACKFILL' : ''}`,
    );
    for (let page = 0; page < maxPages; page += 1) {
      const resp = await fetchPage(samDate(from), samDate(to), offset, limit);
      totalRecords = resp.totalRecords;
      const batch = resp.opportunitiesData ?? [];
      if (batch.length === 0) break;

      for (const oppData of batch) {
        if (!extractor.isDod(oppData)) continue;
        opps += 1;
        const observedAt = parsePostedDate(oppData) ?? new Date();
        const persons = extractor.extract(oppData, knownPeCodes);
        for (const p of persons) {
          people += 1;
          try {
            const result = await writer.upsertPerson(
              {
                fullName: p.fullName,
                title: p.title,
                role: p.role,
                organization: p.organization,
                emailDomain: p.emailDomain,
                email: p.email, // full email — read layer gates to capiro_admin
                pePrimary: p.pePrimary,
                peSecondary: p.peSecondary,
                peCodesMentioned: p.pePrimary ? [p.pePrimary, ...p.peSecondary] : p.peSecondary,
                programOfRecord: p.programOfRecord,
              },
              SAM_SOURCE,
              p.sourceUrl,
              p.snippet,
              observedAt,
              SAM_CONFIDENCE,
            );
            if (result.inserted) inserted += 1;
          } catch (err) {
            errors += 1;
            console.error(`upsert failed for ${p.fullName}: ${String(err)}`);
          }
        }
      }
      offset += limit;
      if (resp.totalRecords !== undefined && offset >= resp.totalRecords) break;
      if (page === maxPages - 1 && resp.totalRecords !== undefined && offset < resp.totalRecords) {
        capped = true;
      }
    }

    if (capped) {
      console.warn(
        `[sam-personnel] ⚠️ CAPPED: window ${samDate(from)}..${samDate(to)} has ${totalRecords} records but the page budget stopped at ${offset} (SAM_MAX_PAGES=${maxPages}). Narrow the window (--posted-to) or raise SAM_MAX_PAGES; the tail was NOT ingested.`,
      );
    }

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: 'success',
        rowsInserted: inserted,
        errorCount: errors,
      },
    });
    console.log(
      JSON.stringify(
        {
          source,
          window: { from: samDate(from), to: samDate(to) },
          opps,
          people,
          inserted,
          errors,
          capped,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: 'error',
        errorCount: errors + 1,
        errorMessage: String(err),
      },
    });
    throw err;
  } finally {
    await prisma.onModuleDestroy();
  }
}

function parsePostedDate(opp: SamOpportunity & { postedDate?: string }): Date | null {
  const raw = opp.postedDate;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
