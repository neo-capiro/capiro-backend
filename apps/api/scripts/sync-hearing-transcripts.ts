/**
 * Track B (H2): ingest OFFICIAL published hearing transcripts from GovInfo's
 * Congressional Hearings (CHRG) collection into `official_hearing_transcript`.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/sync-hearing-transcripts.ts
 *
 * Scoped to a single publication YEAR (default 2026; HEARING_TRANSCRIPT_YEAR)
 * per product scope. Idempotent: official transcripts are IMMUTABLE once
 * published, so a package already stored is skipped (no re-fetch of the text) —
 * steady-state daily runs only pull newly-published transcripts.
 *
 * Text source: GovInfo CHRG `txtLink` (plain text). We deliberately do NOT
 * scrape congress.gov transcript pages (Cloudflare-403 to bots). Correlation to
 * a `committee_hearing` row is a follow-up (H2b); rows land with hearingId=null.
 *
 * Boots a Nest application context so GovInfoService's config (GOVINFO_API_KEY),
 * 24h response cache, and rate limiter all go through the normal service path.
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

const CONGRESS = Number(process.env.HEARING_TRANSCRIPT_CONGRESS ?? 119);
const TARGET_YEAR = Number(process.env.HEARING_TRANSCRIPT_YEAR ?? 2026);
const MIN_TEXT_CHARS = 200; // skip stubs / non-transcript packages

async function loadNest(): Promise<{ AppModule: any; GovInfoService: any; PrismaService: any }> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const gov = await import(`${base}/external/govinfo/govinfo.service.js`);
      const prisma = await import(`${base}/prisma/prisma.service.js`);
      return {
        AppModule: app.AppModule,
        GovInfoService: gov.GovInfoService,
        PrismaService: prisma.PrismaService,
      };
    } catch {
      // try next base
    }
  }
  throw new Error('Could not load AppModule from dist or src');
}

/** CHRG package ids encode the chamber: CHRG-119{s|h|j}hrg{n}. */
function chamberFromPackageId(id: string): string {
  const m = /CHRG-\d+([shj])hrg/i.exec(id);
  const c = m?.[1]?.toLowerCase();
  return c === 's' ? 'Senate' : c === 'h' ? 'House' : c === 'j' ? 'Joint' : 'Unknown';
}

/** Best-effort committee from a CHRG title ("... BEFORE THE COMMITTEE ON X ..."). */
function committeeFromTitle(title: string | null): string | null {
  if (!title) return null;
  const m = /committee on ([^,;:]+?)(?:,|;|:|$)/i.exec(title);
  if (!m) return null;
  return `Committee on ${m[1]!.trim().replace(/\s+/g, ' ')}`.slice(0, 200);
}

function yearOf(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.getUTCFullYear();
}

async function main() {
  const { AppModule, GovInfoService, PrismaService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const t0 = Date.now();
  try {
    const gov = app.get(GovInfoService);
    const prisma = app.get(PrismaService);

    await runWithSyncRun(prisma, 'sync-hearing-transcripts', async () => {
      console.log(
        `[hearing-transcripts] listing CHRG for ${CONGRESS}th Congress (target year ${TARGET_YEAR})`,
      );
      const all = await gov.listHearings(CONGRESS);
      // listCollection currently reads one page (100). For the 2026 window this
      // is ample (published transcripts lag); if we ever hit the cap, paginate.
      if (all.length >= 100) {
        console.warn(
          `[hearing-transcripts] CHRG list returned ${all.length} (>=100 page cap) — ${TARGET_YEAR} packages may be truncated; add pagination if this persists.`,
        );
      }
      const inYear = all.filter(
        (h: { dateIssued: string | null }) => yearOf(h.dateIssued) === TARGET_YEAR,
      );
      console.log(
        `[hearing-transcripts] ${all.length} CHRG packages listed, ${inYear.length} dated ${TARGET_YEAR}`,
      );

      let inserted = 0;
      let skippedExisting = 0;
      let skippedNoText = 0;
      let errors = 0;

      for (const h of inYear as Array<{ hearingId: string; title: string | null; dateIssued: string | null }>) {
        const existing = await prisma.officialHearingTranscript.findUnique({
          where: { id: h.hearingId },
        });
        if (existing) {
          skippedExisting++;
          continue;
        }
        try {
          const doc = await gov.getHearingText(h.hearingId);
          const text = (doc.text ?? '').trim();
          if (text.length < MIN_TEXT_CHARS) {
            skippedNoText++;
            continue;
          }
          const iso = doc.dateIssued ?? h.dateIssued ?? '';
          const date = new Date(iso);
          if (isNaN(date.getTime())) {
            skippedNoText++;
            continue;
          }
          await prisma.officialHearingTranscript.create({
            data: {
              id: h.hearingId,
              hearingId: null, // correlation to committee_hearing is H2b
              source: 'govinfo',
              congress: CONGRESS,
              chamber: chamberFromPackageId(h.hearingId),
              committeeName: committeeFromTitle(doc.title ?? h.title),
              title: doc.title ?? h.title ?? '(untitled hearing)',
              date,
              sourceUrl: doc.sourceUrl,
              format: doc.format,
              text,
              charCount: text.length,
              publishedAt: date,
            },
          });
          inserted++;
        } catch (err) {
          errors++;
          console.warn(`[hearing-transcripts] ${h.hearingId}: ${(err as Error).message}`);
        }
      }

      console.log(
        `[hearing-transcripts] DONE inserted=${inserted} skipped(existing)=${skippedExisting} ` +
          `skipped(no-text)=${skippedNoText} errors=${errors} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      return {
        inserted,
        updated: 0,
        skipped: skippedExisting + skippedNoText,
        errors,
      };
    });
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error('[hearing-transcripts] FAILED', e);
  process.exit(1);
});
