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
 *
 * Committee sourcing (fixed 2026-07-11): `/people`'s `Person` schema has no
 * `current_memberships` field — verified against OpenStates' own live
 * `openapi.json`, whose `/people` `include` enum is only `other_names`,
 * `other_identifiers`, `links`, `sources`, `offices`. The prior code read
 * `p.current_memberships` anyway, so `StateLegislator.committees` was always
 * `[]` and normalize-state-committees.ts (M2.2) had nothing to normalize —
 * `state_committee_membership` stayed empty for every state. Committee
 * membership only exists behind the separate `/committees` endpoint
 * (`include=memberships`, confirmed live against the same openapi.json),
 * whose `CommitteeMembership` rows carry an optional `person` (CompactPerson)
 * ref — optional because OpenStates doesn't always resolve a membership back
 * to a canonical person. A membership with no `person.id` is dropped rather
 * than matched by name (PD2 — never guess an identity match), and counted so
 * the gap is visible in logs, not silent.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { ALL_US_STATE_CODES } from '../src/external/legiscan/us-states.js';
dotenvConfig();

const OS_BASE = 'https://v3.openstates.org';
const OS_KEY = process.env.OPENSTATES_API_KEY ?? '';
const DELAY_MS = 2000;
const MAX_RETRIES = 3;
const PER_PAGE = 20; // OpenStates v3 hard max; per_page>20 -> HTTP 400 (old per_page=100/200 fetched 0 rows)
const MAX_PAGES = 5; // default page ceiling for small resources (committees) — the walk stops early anyway once pagination.max_page is reached
// People must be fully paged, not capped: every priority state legislature has
// MORE than PER_PAGE*MAX_PAGES=100 members (GA 236, NY 213, MA 200, TX 181, IL
// 177, FL 160, VA 140, CA 120), so the old shared 5-page cap silently dropped
// each state's tail — those legislators never got a state_legislator row, so
// they could never be crosswalked and always read "no sponsored bills". 25
// pages covers the largest single chamber (NH House, 400); the walk still
// breaks early at pagination.max_page for smaller states.
const PEOPLE_MAX_PAGES = 25;
const BATCH_SIZE = 10; // process 10 states per run to avoid rate limits
// All states + DC
const ALL_STATES = ALL_US_STATE_CODES.map((s) => s.toLowerCase());

/**
 * Which states this run processes. Default: a day-of-month-rotated batch of
 * BATCH_SIZE states, so the weekly cron cycles all 51 over ~6 weeks. Override
 * with the `OPENSTATES_STATES` env (CSV, e.g. "FL,CA,TX,NY,IL,MA,GA,VA") to
 * process EXACTLY those states in one run — the only way to fully (re)populate a
 * specific set of rosters on demand instead of waiting for their batch day.
 * Mirrors sync-legiscan-masterlist's LEGISCAN_STATES convention. Pure +
 * exported for unit testing.
 */
export function resolveSyncStates(
  overrideCsv: string | undefined,
  allStates: string[],
  dayOfMonth: number,
  batchSize: number,
): string[] {
  const override = (overrideCsv ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (override.length) return override;
  const batchIndex = dayOfMonth % Math.ceil(allStates.length / batchSize);
  return allStates.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
}

const PRIORITY_STATES = resolveSyncStates(
  process.env.OPENSTATES_STATES,
  ALL_STATES,
  new Date().getDate(),
  BATCH_SIZE,
);

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

export interface PagedFetchResult<T> {
  rows: T[];
  /** False when a page failed (fetchOS exhausted retries and returned null) —
   *  the walk stopped early with INCOMPLETE data, not a genuine end-of-results.
   *  Callers that overwrite a DB column from this result must treat `false` as
   *  "unknown", never as "confirmed empty" (PD2 — a fetch failure is not a
   *  fact about the state's real committee roster). */
  complete: boolean;
}

/**
 * Page through an OpenStates v3 list endpoint at the API's max page size.
 * OpenStates rejects per_page>20 with HTTP 400, so we request PER_PAGE rows and
 * walk pages up to MAX_PAGES (or the reported max_page). A failed page (fetchOS
 * exhausted retries) ends the walk with `complete: false` and whatever rows were
 * collected so far — distinct from a legitimate empty/final page, which ends the
 * walk with `complete: true`.
 */
export async function fetchAllPages<T>(
  path: string,
  params: Record<string, string> = {},
  maxPages: number = MAX_PAGES,
): Promise<PagedFetchResult<T>> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    const resp = await fetchOS<{ results: T[]; pagination?: { max_page?: number } }>(path, {
      ...params,
      per_page: String(PER_PAGE),
      page: String(page),
    });
    if (resp === null) return { rows: all, complete: false };
    const rows = resp.results ?? [];
    if (!rows.length) break;
    all.push(...rows);
    const maxPage = resp.pagination?.max_page ?? page;
    if (page >= maxPage) break;
  }
  return { rows: all, complete: true };
}

// ── Committee membership (OpenStates `/committees?include=memberships`) ────
// The `Committee` object itself carries no chamber field (only `classification`
// and `parent_id`, per the live openapi.json) — chamber attribution for the
// roster stays in normalize-state-committees.ts, taken from the LEGISLATOR's
// own `chamber` (state_legislator.chamber), same as before this fix. This file
// only owns the person -> [{name, role}] inversion.

export interface OpenstatesCompactPerson {
  id: string;
  name?: string;
}

export interface OpenstatesCommitteeMembership {
  person_name: string;
  role?: string | null;
  person?: OpenstatesCompactPerson | null;
}

export interface OpenstatesCommittee {
  id: string;
  name: string;
  classification?: string;
  memberships?: OpenstatesCommitteeMembership[] | null;
}

export interface OpenstatesCommitteeEntry {
  name: string;
  role: string | null;
}

export interface InvertCommitteesResult {
  /** OpenStates person id -> that person's committee assignments. */
  committeesByPerson: Map<string, OpenstatesCommitteeEntry[]>;
  /** Memberships with no resolvable `person.id` — real assignments OpenStates
   *  only carries as free text, dropped rather than name-matched (PD2). */
  unlinkedCount: number;
}

/**
 * Invert a `/committees?include=memberships` page set into a per-person
 * committee list, matching the `StateLegislator.committees` Json shape
 * (`[{name, role}]`) that normalize-state-committees.ts already consumes.
 */
export function invertOpenstatesCommittees(
  committees: OpenstatesCommittee[],
): InvertCommitteesResult {
  const committeesByPerson = new Map<string, OpenstatesCommitteeEntry[]>();
  let unlinkedCount = 0;
  for (const committee of committees) {
    for (const membership of committee.memberships ?? []) {
      const personId = membership.person?.id;
      if (!personId) {
        unlinkedCount++;
        continue;
      }
      const entries = committeesByPerson.get(personId) ?? [];
      entries.push({ name: committee.name, role: membership.role ?? null });
      committeesByPerson.set(personId, entries);
    }
  }
  return { committeesByPerson, unlinkedCount };
}

async function main() {
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[openstates-sync] starting');
  console.log(
    `[openstates-sync] states (${process.env.OPENSTATES_STATES ? 'OPENSTATES_STATES override' : 'day-of-month batch'}): ${PRIORITY_STATES.map((s) => s.toUpperCase()).join(', ')}`,
  );
  if (!OS_KEY) throw new Error('OPENSTATES_API_KEY env var is required');

  try {
    await runWithSyncRun(prisma as never, 'sync-openstates', async () => {
      let totalPeople = 0;

      for (const state of PRIORITY_STATES) {
        // Fetch current legislators — fully paged (PEOPLE_MAX_PAGES), since every
        // priority state has >100 members and a truncated roster means missing
        // legislators that can never be crosswalked to their bills.
        const { rows: peopleList } = await fetchAllPages<any>(
          '/people',
          { jurisdiction: state },
          PEOPLE_MAX_PAGES,
        );

        if (peopleList.length) {
          // Fetch committee rosters for the same state and invert to person -> committees,
          // so each legislator upsert below can attach their real assignments.
          const { rows: committeesList, complete: committeesComplete } =
            await fetchAllPages<OpenstatesCommittee>('/committees', {
              jurisdiction: state,
              include: 'memberships',
            });
          const { committeesByPerson, unlinkedCount } = invertOpenstatesCommittees(committeesList);
          if (committeesList.length) {
            const linkedCount = [...committeesByPerson.values()].reduce((n, l) => n + l.length, 0);
            console.log(
              `[openstates-sync] ${state.toUpperCase()} committees: ${committeesList.length} ` +
                `(${linkedCount} memberships linked, ${unlinkedCount} unlinked — no resolvable person)`,
            );
          }
          if (!committeesComplete) {
            // The /committees walk failed part-way through (fetchOS exhausted retries).
            // committeesByPerson is not a trustworthy picture of "this state has no/fewer
            // committees" — writing it would overwrite already-correct existing
            // state_legislator.committees with a false negative. Leave existing rows'
            // committees untouched this run; only a brand-new legislator (create path,
            // nothing to overwrite) gets whatever partial data we did collect.
            console.warn(
              `[openstates-sync] ${state.toUpperCase()} committees fetch incomplete after ` +
                `retries — leaving existing state_legislator.committees untouched this run`,
            );
          }

          for (const p of peopleList) {
            const currentRole = p.current_role;
            const committees = (committeesByPerson.get(p.id) ??
              []) as unknown as Prisma.InputJsonValue;
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
                ...(committeesComplete ? { committees } : {}),
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
                committees,
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

if (require.main === module) {
  main().catch((err) => {
    console.error('[openstates-sync] FAILED', err);
    process.exit(1);
  });
}
