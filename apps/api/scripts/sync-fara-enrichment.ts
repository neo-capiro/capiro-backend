/**
 * Sync FARA foreign-principal ENRICHMENT onto existing FaraRegistration rows.
 *
 *   pnpm --filter @capiro/api sync:fara-enrichment            # dry-run (no writes)
 *   pnpm --filter @capiro/api sync:fara-enrichment -- --commit
 *   FARA_FP_SOURCE_URL=<bulk url> ... --commit --force        # re-assert all
 *
 * Why a separate job from sync-fara: efile.fara.gov/api/v1/Registrants/json/Active
 * (what sync-fara reads) is the active-registrant DIRECTORY ONLY — it carries no
 * foreign principal / country / termination data, so sync-fara stores the
 * FP_UNSPECIFIED sentinel. Those exhibits live in the FARA BULK dataset (one row
 * per registrant x foreign principal), which is NOT exposed by that JSON API.
 *
 * This job pulls the bulk feed from FARA_FP_SOURCE_URL (CSV or JSON — the parser
 * handles both), collapses it to one enrichment per registration, and fills the
 * foreignPrincipal/country/status/terminationDate fields on registrations we
 * already track. It NEVER clobbers an already-real foreign principal unless
 * --force is passed (so hand-verified or previously-enriched values survive a
 * re-run). All decision logic is in src/ingestion/fara-enrichment.ts (unit
 * tested); this file is just fetch + upsert.
 *
 * NOTE: FARA does not publish a stable programmatic bulk URL — the eFile JSON API
 * only serves the active-registrant directory (every other /api/v1 path 404s).
 * Point FARA_FP_SOURCE_URL at a FARA bulk export (the "Active Foreign Principals"
 * download, mirrored to S3, etc.). With no source configured this job is a clean
 * no-op so the schedule never errors.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import {
  parseForeignPrincipalFeed,
  groupEnrichments,
  resolveEnrichmentUpdate,
  type ExistingRegistration,
} from '../src/ingestion/fara-enrichment.js';

dotenvConfig();

const SOURCE_URL = process.env.FARA_FP_SOURCE_URL ?? '';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function flagValue(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function toDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

async function fetchFeed(url: string): Promise<{ body: string; contentType: string } | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'application/json, text/csv, */*',
        // FARA's WAF rejects the default node fetch UA on some paths.
        'User-Agent': 'Mozilla/5.0 (compatible; CapiroIngest/1.0)',
      },
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) {
      console.warn(`[fara-enrichment] source HTTP ${resp.status} for ${url}`);
      return null;
    }
    return { body: await resp.text(), contentType: resp.headers.get('content-type') ?? '' };
  } catch (err) {
    console.warn(`[fara-enrichment] fetch failed: ${(err as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-fara-enrichment.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const commit = hasFlag('commit');
  const force = hasFlag('force');
  const limit = flagValue('limit') ? parseInt(flagValue('limit')!, 10) : null;
  const sourceUrl = flagValue('source') ?? SOURCE_URL;
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log(
    `[fara-enrichment] starting (${commit ? 'COMMIT' : 'DRY_RUN'}${force ? ', FORCE' : ''})`,
  );

  try {
    await runWithSyncRun(prisma as any, 'sync-fara-enrichment', async () => {
      if (!sourceUrl) {
        console.warn(
          '[fara-enrichment] no FARA_FP_SOURCE_URL configured — nothing to enrich. ' +
            'Set it to a FARA bulk foreign-principals export (CSV or JSON). Skipping.',
        );
        return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
      }

      const feed = await fetchFeed(sourceUrl);
      if (!feed || !feed.body.trim()) {
        console.warn('[fara-enrichment] source returned no body; skipping.');
        return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
      }

      const rows = parseForeignPrincipalFeed(feed.body, feed.contentType);
      const enrichments = groupEnrichments(rows);
      console.log(
        `[fara-enrichment] parsed ${rows.length} FP rows -> ${enrichments.size} registrations with enrichment`,
      );

      // Batch-load the registrations we already track (enrichment updates the
      // active directory; it does not invent rows the base sync didn't create).
      const regNos = [...enrichments.keys()];
      const existing = await prisma.faraRegistration.findMany({
        where: { registrationNumber: { in: regNos } },
        select: {
          registrationNumber: true,
          foreignPrincipal: true,
          country: true,
          status: true,
          terminationDate: true,
        },
      });
      const existingByReg = new Map<string, ExistingRegistration>(
        existing.map((e) => [e.registrationNumber, e]),
      );

      let updated = 0;
      let skippedNoChange = 0;
      let absent = 0;
      let processed = 0;
      for (const [reg, enrichment] of enrichments) {
        if (limit !== null && processed >= limit) break;
        processed++;
        const existingRow = existingByReg.get(reg);
        if (!existingRow) {
          absent++; // in the FP feed but not in our active-registrant table
          continue;
        }
        const update = resolveEnrichmentUpdate(existingRow, enrichment, { force });
        if (!update) {
          skippedNoChange++;
          continue;
        }
        if (commit) {
          await prisma.faraRegistration.update({
            where: { registrationNumber: reg },
            data: {
              foreignPrincipal: update.foreignPrincipal,
              ...(update.country !== null ? { country: update.country } : {}),
              ...(update.status !== null ? { status: update.status } : {}),
              ...(update.terminationDate !== null
                ? { terminationDate: toDate(update.terminationDate) }
                : {}),
              syncedAt: new Date(),
            },
          });
        }
        updated++;
      }

      console.log(
        `[fara-enrichment] ${commit ? 'updated' : 'would update'}: ${updated}, ` +
          `unchanged: ${skippedNoChange}, absent-from-table: ${absent}`,
      );
      console.log(`[fara-enrichment] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { inserted: 0, updated, skipped: skippedNoChange, errors: 0 };
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
main().catch((err) => {
  console.error('[fara-enrichment] FAILED', err);
  process.exit(1);
});
}
