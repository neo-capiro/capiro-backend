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
// Local exponential backoff stays bounded (DELAY_MS * 2^attempt, capped here)
// for 429s that carry no usable Retry-After hint. A VALID provider hint is
// honored in full instead — see fetchOS.
const MAX_LOCAL_BACKOFF_MS = 30000;
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

export interface FetchOSOptions {
  /** Injectable sleep for deterministic tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (ms since epoch) for Retry-After HTTP-date parsing. */
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Parse a Retry-After header value into milliseconds from `nowMs`.
 * Supports both valid forms: delta-seconds and HTTP-date (RFC 9110 §10.2.3).
 * Returns null for missing/invalid/negative values — a malformed hint must
 * never extend or shorten the wait beyond the local backoff policy.
 */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - nowMs;
  return delta > 0 ? delta : null;
}

async function fetchOS<T>(
  path: string,
  params: Record<string, string> = {},
  options: FetchOSOptions = {},
): Promise<T | null> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const url = new URL(`${OS_BASE}${path}`);
  url.searchParams.set('apikey', OS_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url.toString());
      if (resp.status === 429) {
        if (attempt === MAX_RETRIES) {
          // Retries exhausted: surface the failure WITHOUT sleeping again —
          // the old code slept 30s here and then left the loop without ever
          // making the announced retry (logs showed "attempt 4/3").
          console.warn(`GET ${path}: 429 rate limited, retries exhausted`);
          return null;
        }
        const backoff = Math.min(DELAY_MS * Math.pow(2, attempt + 1), MAX_LOCAL_BACKOFF_MS);
        // A valid provider Retry-After is the wait floor and is honored in
        // full — retrying sooner just earns another 429 (the old code capped
        // the hint at 30s, so a 120s Retry-After was retried at 30/60/90s and
        // exhausted before the provider's deadline). With no valid hint the
        // bounded local backoff applies. An unrepresentably large hint cannot
        // be scheduled honestly: return null now (partial/defer) instead of
        // overflowing a timer or pretending the wait happened.
        const hint = parseRetryAfterMs(resp.headers?.get?.('retry-after') ?? null, now());
        if (hint !== null && hint > 0x7fffffff) {
          console.warn(`GET ${path}: 429 Retry-After ${hint}ms is unschedulable — deferring`);
          return null;
        }
        const wait = hint !== null ? Math.max(backoff, hint) : backoff;
        console.warn(
          `GET ${path}: 429 rate limited, retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(wait);
        continue;
      }
      if (!resp.ok) throw new Error(`${resp.status}`);
      return (await resp.json()) as T;
    } catch (err) {
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

export interface FetchAllPagesOptions extends FetchOSOptions {}

/**
 * Page through an OpenStates v3 list endpoint at the API's max page size.
 * OpenStates rejects per_page>20 with HTTP 400, so we request PER_PAGE rows and
 * walk pages up to maxPages (or the reported max_page). A failed page (fetchOS
 * exhausted retries) ends the walk with `complete: false` and whatever rows were
 * collected so far — distinct from a legitimate empty/final page, which ends the
 * walk with `complete: true`. Exhausting the LOCAL maxPages ceiling while the
 * provider reports more pages (pagination.max_page beyond the pages fetched)
 * is also `complete: false`: a truncated tail is not end-of-results.
 */
export async function fetchAllPages<T>(
  path: string,
  params: Record<string, string> = {},
  maxPages: number = MAX_PAGES,
  options: FetchAllPagesOptions = {},
): Promise<PagedFetchResult<T>> {
  const sleep = options.sleep ?? defaultSleep;
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    await sleep(DELAY_MS);
    const resp = await fetchOS<{ results: T[]; pagination?: { max_page?: number } }>(
      path,
      {
        ...params,
        per_page: String(PER_PAGE),
        page: String(page),
      },
      options,
    );
    if (resp === null) return { rows: all, complete: false };
    const rows = resp.results ?? [];
    if (!rows.length) return { rows: all, complete: true };
    all.push(...rows);
    const maxPage = resp.pagination?.max_page ?? page;
    if (page >= maxPage) return { rows: all, complete: true };
    if (page === maxPages) {
      // Local ceiling hit with provider pages still unfetched — the tail was
      // truncated by OUR cap, not by the source running out of rows.
      return { rows: all, complete: false };
    }
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

/**
 * Per-state source outcome from the two OpenStates fetches, aggregated into
 * the run-level counts main() returns. Pure + exported for unit testing.
 * `peoplePartial`/`committeesPartial` are row counts written from incomplete
 * page walks; they stay visible instead of masquerading as a clean success.
 */
export interface OpenstatesStateOutcome {
  peopleFetched: number;
  peopleComplete: boolean;
  committeesComplete: boolean;
}

export function aggregateStateOutcomes(states: OpenstatesStateOutcome[]): {
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  complete: boolean;
  incompleteReason?: string;
  errorMessage?: string;
} {
  const inserted = states.reduce((n, s) => n + s.peopleFetched, 0);
  const incomplete = states.filter((s) => !s.peopleComplete || !s.committeesComplete);
  if (!incomplete.length) {
    return { inserted, updated: 0, skipped: 0, errors: 0, complete: true };
  }
  const peopleFailed = incomplete.filter((s) => !s.peopleComplete).length;
  const committeesFailed = incomplete.filter((s) => !s.committeesComplete).length;
  const parts: string[] = [];
  if (peopleFailed) parts.push(`${peopleFailed} state(s) with incomplete people pages`);
  if (committeesFailed) parts.push(`${committeesFailed} state(s) with incomplete committee pages`);
  const reason = parts.join('; ');
  return {
    inserted,
    updated: 0,
    skipped: 0,
    errors: incomplete.length,
    complete: false,
    incompleteReason: reason,
    errorMessage: reason,
  };
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
      const outcomes: OpenstatesStateOutcome[] = [];

      for (const state of PRIORITY_STATES) {
        // Fetch current legislators — fully paged (PEOPLE_MAX_PAGES), since every
        // priority state has >100 members and a truncated roster means missing
        // legislators that can never be crosswalked to their bills. Rows already
        // fetched before a failed page are still real data and are upserted below
        // (incremental people behavior), but the state is NOT complete.
        const { rows: peopleList, complete: peopleComplete } = await fetchAllPages<any>(
          '/people',
          { jurisdiction: state },
          PEOPLE_MAX_PAGES,
        );

        let committeesComplete = true;
        if (!peopleComplete) {
          console.warn(
            `[openstates-sync] ${state.toUpperCase()} people fetch incomplete after ` +
              `retries — ${peopleList.length} partial rows kept; source run will be partial`,
          );
        }

        if (peopleList.length) {
          // Fetch committee rosters for the same state and invert to person -> committees,
          // so each legislator upsert below can attach their real assignments.
          const committeesPage = await fetchAllPages<OpenstatesCommittee>('/committees', {
            jurisdiction: state,
            include: 'memberships',
          });
          const committeesList = committeesPage.rows;
          committeesComplete = committeesPage.complete;
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

        outcomes.push({
          peopleFetched: peopleList.length,
          peopleComplete,
          committeesComplete,
        });
      }

      console.log(`[openstates-sync] total: ${totalPeople} legislators`);
      console.log(`[openstates-sync] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      const counts = aggregateStateOutcomes(outcomes);
      if (!counts.complete) {
        console.warn(`[openstates-sync] run INCOMPLETE: ${counts.incompleteReason}`);
      }
      return counts;
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
