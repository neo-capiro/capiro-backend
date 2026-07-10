/**
 * Sync Open States, state legislature PEOPLE + COMMITTEES only (State
 * Legislation Platform DD2 — LegiScan is the bill spine; OpenStates bills are
 * a cross-check, not the source of record. The bills loop this file used to
 * run was removed 2026-07-10 — LegiScan's getMasterListRaw/getBill replaced it
 * (backfill-legiscan-datasets.ts, sync-legiscan-masterlist.ts,
 * sync-legiscan-bills.ts): OpenStates v3 bills paginate at a 20-row hard max
 * with no change-hash diff, the exact throttle problem LegiScan's Pull API
 * solves).
 *   pnpm --filter @capiro/api sync:openstates
 * Source: v3.openstates.org/
 * Auth: Free API key. Key in env: OPENSTATES_API_KEY
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { ALL_US_STATE_CODES } from '../src/external/legiscan/us-states.js';
dotenvConfig();

const OS_BASE = 'https://v3.openstates.org';
const OS_KEY = process.env.OPENSTATES_API_KEY ?? '';
const DELAY_MS = 2000;
const MAX_RETRIES = 3;
const PER_PAGE = 20; // OpenStates v3 hard max; per_page>20 -> HTTP 400 (old per_page=100/200 fetched 0 rows)
const MAX_PAGES = 5; // up to PER_PAGE*MAX_PAGES rows/state/resource per run; full coverage builds over the weekly cycle
const BATCH_SIZE = 10; // process 10 states per run to avoid rate limits
// All states + DC
const ALL_STATES = ALL_US_STATE_CODES.map((s) => s.toLowerCase());
// Pick batch based on day of month to cycle through all states
const batchIndex = new Date().getDate() % Math.ceil(ALL_STATES.length / BATCH_SIZE);
const PRIORITY_STATES = ALL_STATES.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE);

async function fetchOS<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  const url = new URL(`${OS_BASE}${path}`);
  url.searchParams.set('apikey', OS_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url.toString());
      if (resp.status === 429) {
        const wait = Math.min(DELAY_MS * Math.pow(2, attempt + 1), 30000);
        console.warn(
          `GET ${path}: 429 rate limited, retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!resp.ok) throw new Error(`${resp.status}`);
      return (await resp.json()) as T;
    } catch (err) {
      if (attempt < MAX_RETRIES && (err as Error).message?.includes('429')) continue;
      console.warn(`GET ${path}: ${(err as Error).message}`);
      return null;
    }
  }
  return null;
}

/**
 * Page through an OpenStates v3 list endpoint at the API's max page size.
 * OpenStates rejects per_page>20 with HTTP 400, so we request PER_PAGE rows and
 * walk pages up to MAX_PAGES (or the reported max_page). A null page (error or
 * rate-limit after retries) ends the walk. Returns the flattened results.
 */
async function fetchAllPages<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    const resp = await fetchOS<{ results: T[]; pagination?: { max_page?: number } }>(path, {
      ...params,
      per_page: String(PER_PAGE),
      page: String(page),
    });
    const rows = resp?.results ?? [];
    if (!rows.length) break;
    all.push(...rows);
    const maxPage = resp?.pagination?.max_page ?? page;
    if (page >= maxPage) break;
  }
  return all;
}

async function main() {
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[openstates-sync] starting');
  console.log(
    `[openstates-sync] batch ${batchIndex}: ${PRIORITY_STATES.map((s) => s.toUpperCase()).join(', ')}`,
  );
  if (!OS_KEY) throw new Error('OPENSTATES_API_KEY env var is required');

  try {
    await runWithSyncRun(prisma as never, 'sync-openstates', async () => {
      let totalPeople = 0;

      for (const state of PRIORITY_STATES) {
        // Fetch current legislators, paged at the API max (per_page=200 -> 400).
        const peopleList = await fetchAllPages<any>('/people', { jurisdiction: state });

        if (peopleList.length) {
          for (const p of peopleList) {
            const currentRole = p.current_role;
            await prisma.stateLegislator.upsert({
              where: { id: p.id },
              update: {
                name: p.name,
                state: state.toUpperCase(),
                chamber: currentRole?.org_classification || null,
                district: currentRole?.district?.toString() || null,
                party: p.party || null,
                email: p.email || null,
                image: p.image || null,
                url: p.openstates_url || null,
                committees: (p.current_memberships || [])
                  .filter((m: any) => m.organization?.classification === 'committee')
                  .map((m: any) => ({ name: m.organization?.name, role: m.role })),
                active: true,
                syncedAt: new Date(),
              },
              create: {
                id: p.id,
                name: p.name,
                state: state.toUpperCase(),
                chamber: currentRole?.org_classification || null,
                district: currentRole?.district?.toString() || null,
                party: p.party || null,
                email: p.email || null,
                image: p.image || null,
                url: p.openstates_url || null,
                committees: (p.current_memberships || [])
                  .filter((m: any) => m.organization?.classification === 'committee')
                  .map((m: any) => ({ name: m.organization?.name, role: m.role })),
              },
            });
            await prisma.entityCrosswalk.upsert({
              where: { idType_idValue: { idType: 'openstates_person', idValue: p.id } },
              create: {
                idType: 'openstates_person',
                idValue: p.id,
                entityType: 'state_legislator',
                entityKey: p.id,
                source: 'sync-openstates',
              },
              update: { entityKey: p.id, source: 'sync-openstates' },
            });
            totalPeople++;
          }
          console.log(`[openstates-sync] ${state.toUpperCase()} legislators: ${peopleList.length}`);
        }
      }

      console.log(`[openstates-sync] total: ${totalPeople} legislators`);
      console.log(`[openstates-sync] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { inserted: totalPeople, updated: 0, skipped: 0, errors: 0 };
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[openstates-sync] FAILED', err);
  process.exit(1);
});
