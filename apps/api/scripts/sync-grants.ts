/**
 * Sync Grants.gov federal grant OPPORTUNITIES (NOFOs) — not awarded money.
 *
 *   pnpm --filter @capiro/api sync:grants                  # daily: posted|forecasted
 *   tsx scripts/sync-grants.ts --all-statuses              # weekly reconcile: all four
 *
 * Source: api.grants.gov/v1/api/search2. No auth required.
 *
 * SCOPE — verified live 2026-07-24, search2 returns exactly ten fields per hit:
 *   id, number, title, agencyCode, agency, openDate, closeDate, oppStatus,
 *   docType, cfdaList
 * That is all this script may write. Everything else on federal_grant
 * (category, fundingInstrument, awardCeiling, awardFloor, estimatedFunding,
 * description, eligibility, expectedAwards and the whole detail block) is from the
 * fetchOpportunity payload and is owned by enrich-grant-details.ts. This
 * script previously listed those columns in its upsert, where they resolved
 * to `null` on every run — harmless while nothing else wrote them, but it
 * would have wiped the enrichment pass's work on the next daily run. They are
 * deliberately absent from both the create and the update path now.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

const GRANTS_BASE = 'https://api.grants.gov/v1/api/search2';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const DELAY_MS = 300;

const DAILY_STATUSES = 'posted|forecasted';
const ALL_STATUSES = 'forecasted|posted|closed|archived';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * search2 emits dates as MM/DD/YYYY (and "" for a forecast with no close
 * date). Parsed explicitly into a UTC midnight Date: `new Date('07/24/2026')`
 * would yield LOCAL midnight, which lands on the previous calendar day once
 * Prisma narrows it to @db.Date on any host east of UTC.
 */
export function parseGrantsDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  if (m) {
    const [, mm, dd, yyyy] = m;
    return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export interface Search2Hit {
  id?: string | number;
  opportunityId?: string | number;
  number?: string | null;
  title?: string | null;
  agencyCode?: string | null;
  agency?: string | null;
  openDate?: string | null;
  closeDate?: string | null;
  oppStatus?: string | null;
  docType?: string | null;
  cfdaList?: string[] | null;
}

/**
 * The exact column set search2 can support, and nothing more. Returned shape
 * is used for both halves of the upsert (minus `id`, which is the key).
 */
export function buildOpportunityFields(g: Search2Hit) {
  return {
    title: g.title || 'Untitled',
    // `agency` is the full agency name ("Fish and Wildlife Service");
    // agencyCode is the dotted code ("DOI-FWS"). Prefer the name, fall back
    // to the code so the NOT NULL column always has something real.
    agency: g.agency || g.agencyCode || 'Unknown',
    opportunityNumber: g.number || null,
    openDate: parseGrantsDate(g.openDate),
    closeDate: parseGrantsDate(g.closeDate),
    status: g.oppStatus || null,
    docType: g.docType || null,
    cfdaNumbers: Array.isArray(g.cfdaList) ? g.cfdaList.filter((c) => typeof c === 'string') : [],
    url: `https://www.grants.gov/search-results-detail/${String(g.id ?? g.opportunityId)}`,
  };
}

export interface SearchPage {
  hits: Search2Hit[];
  hitCount: number | null;
}

export async function fetchSearchPage(oppStatuses: string, page: number): Promise<SearchPage> {
  const resp = await fetch(GRANTS_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keyword: '',
      oppStatuses,
      sortBy: 'openDate|desc',
      rows: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
  });
  if (!resp.ok) throw new Error(`grants.gov search2 HTTP ${resp.status}`);
  const body = (await resp.json()) as any;
  // search2 wraps the payload in a `data` envelope:
  //   { errorcode, msg, token, data: { oppHits, hitCount, ... } }
  // The original code read top-level `oppHits`, which is always absent, so
  // every run saw 0 hits. Fall back to `body` for forward-compat in case the
  // envelope is ever flattened.
  const payload = body?.data ?? body;
  return {
    hits: Array.isArray(payload?.oppHits) ? payload.oppHits : [],
    hitCount: typeof payload?.hitCount === 'number' ? payload.hitCount : null,
  };
}

/**
 * Close out opportunities whose deadline has passed but which the daily
 * posted|forecasted query can no longer see (so they'd otherwise sit at
 * status='posted' forever). Purely date-driven — nothing is inferred about
 * an opportunity that has no closeDate, and forecasts are never touched
 * because a forecast's date is an estimate, not a deadline.
 */
export const EXPIRE_SQL = `
  UPDATE federal_grant
     SET status = 'closed'
   WHERE status = 'posted'
     AND doc_type IS DISTINCT FROM 'forecast'
     AND close_date IS NOT NULL
     AND close_date < CURRENT_DATE
`;

export interface GrantsPrisma {
  federalGrant: {
    upsert(args: { where: { id: string }; update: unknown; create: unknown }): Promise<unknown>;
  };
  $executeRawUnsafe(sql: string): Promise<number>;
}

export interface SyncDeps {
  fetchSearchPage: typeof fetchSearchPage;
  sleep: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exported for unit testing with a mocked fetcher — no live calls, no real DB. */
export async function syncOpportunities(
  prisma: GrantsPrisma,
  opts: { allStatuses: boolean },
  deps: SyncDeps = { fetchSearchPage, sleep: realSleep },
): Promise<RunCounts> {
  const oppStatuses = opts.allStatuses ? ALL_STATUSES : DAILY_STATUSES;
  let total = 0;
  let errors = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await deps.sleep(DELAY_MS);
    const { hits, hitCount } = await deps.fetchSearchPage(oppStatuses, page);
    if (!hits.length) break;

    for (const g of hits) {
      const id = String(g.id ?? g.opportunityId ?? '');
      if (!id || id === 'undefined' || id === 'null') continue;
      const fields = buildOpportunityFields(g);
      try {
        await prisma.federalGrant.upsert({
          where: { id },
          update: { ...fields, syncedAt: new Date() },
          create: { id, ...fields },
        });
        total++;
      } catch (e) {
        errors++;
        console.error(`[grants-sync] ${id} failed: ${(e as Error).message}`);
      }
    }

    console.log(
      `[grants-sync] page ${page + 1}: ${hits.length} opportunities (total: ${total}, hitCount: ${hitCount ?? '?'})`,
    );
    if (hits.length < PAGE_SIZE) break;
    // grants.gov keeps returning full pages past hitCount (offset is not
    // honored past the end), which just re-upserts the same rows. Stop once
    // the reported total is covered.
    if (hitCount && total >= hitCount) break;
  }

  const expired = await prisma.$executeRawUnsafe(EXPIRE_SQL);
  if (expired > 0) console.log(`[grants-sync] marked ${expired} past-deadline opportunities closed`);

  return { inserted: total, updated: expired, skipped: 0, errors };
}

async function main() {
  const allStatuses = hasFlag('all-statuses');
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log(`[grants-sync] starting (statuses=${allStatuses ? ALL_STATUSES : DAILY_STATUSES})`);

  try {
    const counts = await runWithSyncRun(
      prisma as unknown as Parameters<typeof runWithSyncRun>[0],
      'sync-grants',
      () => syncOpportunities(prisma as unknown as GrantsPrisma, { allStatuses }),
    );
    console.log(
      `[grants-sync] DONE upserted=${counts.inserted} expired=${counts.updated} errors=${counts.errors} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Guard against firing on import — the spec imports the testable exports
// directly and must not trigger a live PrismaClient connect.
if (require.main === module) {
  main().catch((err) => {
    console.error('[grants-sync] FAILED', err);
    process.exit(1);
  });
}
