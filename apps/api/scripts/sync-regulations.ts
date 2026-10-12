/**
 * sync-regulations.ts, Fetch dockets from Regulations.gov API
 *
 * API docs: https://open.gsa.gov/api/regulationsgov/
 * Auth: API key via `api_key` query param
 * Rate limit: 1,000 requests/hour
 *
 * Usage:
 *   DATABASE_URL=... REGULATIONS_GOV_API_KEY=... tsx scripts/sync-regulations.ts
 *
 * Modes (selected by argv / env):
 *   (default)               full-history pull from 2021-01-01
 *   --incremental           daily delta from the latest non-future postedDate
 *                           (env REG_SYNC_INCREMENTAL=1)
 *   --since <YYYY-MM-DD>     explicit floor (env REG_SYNC_SINCE)
 *   --backfill-from <date>   WINDOWED historical backfill from <date> to today
 *                           (env REG_BACKFILL_FROM). Regulations.gov caps every query
 *                           at ~5,000 results (page[number] <= 20 x page[size] 250), so a
 *                           single wide floor-only query returns nothing. This walks fixed
 *                           date windows (env REG_BACKFILL_WINDOW_DAYS, default 30), each
 *                           bounded by ge+le, keeping every query under the cap.
 */

import { PrismaClient } from '@prisma/client';

const API_KEY = process.env.REGULATIONS_GOV_API_KEY;
const BASE_URL = 'https://api.regulations.gov/v4';
const PAGE_SIZE = 250;
const DELAY_MS = 400; // stay well under 1K/hr
const MAX_PAGES_PER_QUERY = 20; // Regulations.gov hard cap: page[number] <= 20 (=> 5,000 docs)

interface RegDocument {
  id: string;
  type: string;
  attributes: {
    agencyId: string;
    commentEndDate: string | null;
    commentStartDate: string | null;
    docketId: string;
    documentType: string; // Rule, Proposed Rule, Notice, Other
    frDocNum: string | null;
    lastModifiedDate: string;
    objectId: string;
    postedDate: string;
    subtype: string | null;
    title: string;
    withdrawn: boolean;
  };
}

interface RegResponse {
  data: RegDocument[];
  meta: { hasNextPage: boolean; totalElements: number };
}

async function fetchPage(
  pageNumber: number,
  postedAfter: string,
  postedBefore?: string,
): Promise<RegResponse> {
  const params = new URLSearchParams({
    'api_key': API_KEY!,
    'filter[postedDate][ge]': postedAfter,
    'page[size]': String(PAGE_SIZE),
    'page[number]': String(pageNumber),
    'sort': '-postedDate',
  });
  // Upper bound is only set for windowed backfills; daily/since runs stay open-ended.
  if (postedBefore) {
    params.set('filter[postedDate][le]', postedBefore);
  }

  const url = `${BASE_URL}/documents?${params}`;
  const res = await fetch(url);

  if (res.status === 429) {
    console.warn('[reg-sync] 429 rate limited, waiting 60s');
    await sleep(60_000);
    return fetchPage(pageNumber, postedAfter, postedBefore);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Regulations.gov API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<RegResponse>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertDocket(prisma: PrismaClient, doc: RegDocument): Promise<void> {
  const attrs = doc.attributes;
  await prisma.$executeRawUnsafe(
    `INSERT INTO regulatory_docket (
      id, document_id, agency_id, docket_id, document_type, title,
      posted_date, comment_start_date, comment_end_date,
      fr_doc_num, subtype, withdrawn, last_modified, synced_at
    ) VALUES (
      gen_random_uuid(), $1, $2, $3, $4, $5,
      $6::timestamptz, $7::timestamptz, $8::timestamptz,
      $9, $10, $11, $12::timestamptz, NOW()
    )
    ON CONFLICT (document_id) DO UPDATE SET
      title = EXCLUDED.title,
      comment_end_date = EXCLUDED.comment_end_date,
      last_modified = EXCLUDED.last_modified,
      withdrawn = EXCLUDED.withdrawn,
      synced_at = NOW()`,
    doc.id,
    attrs.agencyId,
    attrs.docketId,
    attrs.documentType,
    attrs.title,
    attrs.postedDate ? new Date(attrs.postedDate) : null,
    attrs.commentStartDate ? new Date(attrs.commentStartDate) : null,
    attrs.commentEndDate ? new Date(attrs.commentEndDate) : null,
    attrs.frDocNum,
    attrs.subtype,
    attrs.withdrawn ?? false,
    attrs.lastModifiedDate ? new Date(attrs.lastModifiedDate) : null,
  );
}

/**
 * Paginate one [postedAfter, postedBefore?] query, upserting every docket.
 * Returns the number of docs processed and whether the page cap was hit (which
 * means the window matched > ~5,000 docs and the tail was NOT fetched).
 */
async function ingestRange(
  prisma: PrismaClient,
  postedAfter: string,
  postedBefore?: string,
  maxPages: number = Number.MAX_SAFE_INTEGER,
  label = 'reg-sync',
): Promise<{ count: number; truncated: boolean }> {
  let page = 1;
  let count = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await fetchPage(page, postedAfter, postedBefore);
    const docs = result.data;

    for (const doc of docs) {
      await upsertDocket(prisma, doc);
      count++;
    }

    console.log(`[${label}] page ${page}: ${docs.length} docs (${count} total)`);

    if (result.meta.hasNextPage && docs.length > 0 && page >= maxPages) {
      return { count, truncated: true };
    }
    hasMore = result.meta.hasNextPage && docs.length > 0;
    page++;
    await sleep(DELAY_MS);
  }

  return { count, truncated: false };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Windowed historical backfill: walk fixed date windows from `from` to today,
 * each bounded by ge+le so no single query exceeds the API's ~5,000-result cap.
 */
async function runBackfill(prisma: PrismaClient, from: string, windowDays: number): Promise<void> {
  const today = new Date();
  let winStart = new Date(`${from}T00:00:00Z`);
  let grandTotal = 0;
  let windows = 0;
  let truncated = 0;

  console.log(`[reg-backfill] from=${from} to=${ymd(today)} windowDays=${windowDays}`);

  while (winStart.getTime() <= today.getTime()) {
    const winEnd = new Date(winStart);
    winEnd.setUTCDate(winEnd.getUTCDate() + windowDays - 1);
    const startStr = ymd(winStart);
    const endStr = ymd(winEnd.getTime() < today.getTime() ? winEnd : today);

    const { count, truncated: wasTruncated } = await ingestRange(
      prisma,
      startStr,
      endStr,
      MAX_PAGES_PER_QUERY,
      `reg-backfill ${startStr}`,
    );
    grandTotal += count;
    windows++;
    if (wasTruncated) {
      truncated++;
      console.warn(
        `[reg-backfill] WINDOW TRUNCATED ${startStr}..${endStr}: hit the ${MAX_PAGES_PER_QUERY}-page cap ` +
          `(>${MAX_PAGES_PER_QUERY * PAGE_SIZE} docs). Re-run with a smaller REG_BACKFILL_WINDOW_DAYS to cover it fully.`,
      );
    }
    console.log(
      `[reg-backfill] window ${startStr}..${endStr}: ${count} docs (grand total ${grandTotal})`,
    );

    winStart = new Date(winStart);
    winStart.setUTCDate(winStart.getUTCDate() + windowDays);
    await sleep(DELAY_MS);
  }

  console.log(
    `[reg-backfill] DONE: ${grandTotal} docs across ${windows} windows` +
      (truncated ? `, ${truncated} window(s) TRUNCATED (re-run with smaller windows)` : ''),
  );
  console.log(
    `INGESTION_METRIC ${JSON.stringify({
      source: 'backfill-regulations',
      rows_inserted: grandTotal,
      rows_updated: 0,
      error_count: 0,
      windows,
      truncated_windows: truncated,
    })}`,
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-regulations.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  if (!API_KEY) {
    console.error('[reg-sync] REGULATIONS_GOV_API_KEY not set');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const start = Date.now();
    console.log('[reg-sync] Starting Regulations.gov sync...');

    // Windowed historical backfill mode (env REG_BACKFILL_FROM or --backfill-from <date>).
    // Takes precedence over the daily/incremental path.
    const backfillFrom = (() => {
      const i = process.argv.indexOf('--backfill-from');
      return i >= 0 ? process.argv[i + 1] : process.env.REG_BACKFILL_FROM;
    })();
    if (backfillFrom) {
      const windowDays = Math.max(
        1,
        parseInt(process.env.REG_BACKFILL_WINDOW_DAYS || '30', 10) || 30,
      );
      await runBackfill(prisma, backfillFrom.slice(0, 10), windowDays);
      return;
    }

    // Incremental: max(posted_at) in DB becomes the floor. The full-history
    // pull from 2021 is the default for the first run; afterward, daily syncs
    // only fetch newly posted dockets. --incremental flag or env override.
    const incremental =
      process.argv.includes('--incremental') || process.env.REG_SYNC_INCREMENTAL === '1';
    const sinceOverride = (() => {
      const i = process.argv.indexOf('--since');
      return i >= 0 ? process.argv[i + 1] : process.env.REG_SYNC_SINCE;
    })();
    let postedAfter = '2021-01-01';
    if (sinceOverride) {
      postedAfter = sinceOverride.slice(0, 10);
    } else if (incremental) {
      // Use the latest *non-future* postedDate as the incremental floor.
      // Regulations.gov occasionally returns dockets with a postedDate in the
      // future; taking a raw MAX(posted_date) lets one such row poison the
      // watermark and stall every subsequent sync (observed 2026-06: floor stuck
      // at 2026-12-13, fetching 1 doc/run). Ignoring future-dated rows keeps the
      // floor sane, and a 2-day overlap re-captures late edits near the boundary.
      const latest = await prisma.regulatoryDocket.findFirst({
        where: { postedDate: { lte: new Date() } },
        orderBy: { postedDate: 'desc' },
        select: { postedDate: true },
      });
      if (latest?.postedDate) {
        const floor = new Date(latest.postedDate);
        floor.setUTCDate(floor.getUTCDate() - 2);
        postedAfter = floor.toISOString().slice(0, 10);
      }
    }
    console.log(`[reg-sync] postedAfter=${postedAfter} (incremental=${incremental})`);

    const { count } = await ingestRange(prisma, postedAfter);

    const elapsed = ((Date.now() - start) / 60_000).toFixed(1);
    console.log(`[reg-sync] DONE in ${elapsed}m, ${count} documents synced`);
    console.log(
      `INGESTION_METRIC ${JSON.stringify({
        source: 'sync-regulations',
        rows_inserted: count,
        rows_updated: 0,
        error_count: 0,
        duration_seconds: Math.round((Date.now() - start) / 1000),
      })}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error('[reg-sync]', err);
    process.exit(1);
  });
}
