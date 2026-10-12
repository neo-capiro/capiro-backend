/** @cleanup-smoke noArgsExit=2 */
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
 * GovInfoService is resolved with { strict: false } and requires GovInfoModule to
 * be imported by AppModule (wired in #309).
 *
 * Run as an ECS one-off with the full-app task-def + TMPDIR=/dev/shm (the tsx IPC
 * dir; the server task-def's default /app/tmp isn't writable — infra_tsx_tmpdir_bug).
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { syncGovInfoHearingRecords } from '../src/ingestion/govinfo-hearing-records.js';

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
  if (!process.env.DATABASE_URL) {
    console.error('Usage: sync-hearing-transcripts (requires DATABASE_URL)');
    process.exitCode = 2;
    return;
  }
  const { AppModule, GovInfoService, PrismaService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const t0 = Date.now();
  try {
    // strict:false — resolve providers that live in feature modules (GovInfoService
    // is in GovInfoModule, not the root/global scope).
    const gov = app.get(GovInfoService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    await runWithSyncRun(prisma, 'sync-hearing-transcripts', async () => {
      console.log(
        `[hearing-transcripts] listing CHRG for ${CONGRESS}th Congress (target year ${TARGET_YEAR})`,
      );
      return syncGovInfoHearingRecords(prisma, gov, CONGRESS, TARGET_YEAR);
    });
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error('[hearing-transcripts] FAILED', e);
  process.exit(1);
});
