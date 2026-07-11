/**
 * One-time LegiScan bulk-dataset backfill + quota-exhaustion fallback (State
 * Legislation Platform, Phase 0 S1.3.1). Seeds every state/session from
 * LegiScan's weekly bulk dataset ZIPs (getDatasetList + getDataset) — ~2-3
 * queries/state, vs ~100k getBill calls if the first masterlist walk were
 * allowed to mark every in-session bill "changed" and drain it one at a time.
 * Feeds every bill through the SAME normalize function the drain uses
 * (legiscan-normalize.ts), then primes state_sync_cursor.billHashes from the
 * dataset's hashes so the next masterlist diff only picks up genuine changes.
 *
 * Also the quota-exhaustion FALLBACK: when sync-legiscan-bills' monthly
 * budget governor trips (S1.5), re-running this for non-priority states is
 * the cheap path to stay fresh without draining bill-by-bill.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-legiscan-datasets.ts
 * Env: LEGISCAN_API_KEY (required), LEGISCAN_STATES (CSV or "all", default the
 *      8 Rev-2 priority states), LEGISCAN_SESSIONS=current|all (default
 *      current — "all" also seeds prior/historical sessions, materially more
 *      expensive, intended for a one-off deep backfill only).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import {
  getDatasetList,
  getDataset,
  getSessionList,
} from '../src/external/legiscan/legiscan.client.js';
import { parseDatasetZip } from '../src/external/legiscan/legiscan-dataset.util.js';
import { ALL_US_STATE_CODES, PRIORITY_STATE_CODES } from '../src/external/legiscan/us-states.js';
import {
  normalizeLegiscanBill,
  upsertNormalizedStateBill,
  upsertStateSession,
  upsertStateRollCallVote,
  crosswalkStateBill,
  crosswalkLegiscanPerson,
  backfillStateBillLinkTargets,
} from '../src/ingestion/legiscan-normalize.js';
import {
  currentQuotaMonth,
  monthToDateQueries,
  quotaExhausted,
  LEGISCAN_HARD_CAP,
} from '../src/ingestion/legiscan-quota.util.js';
dotenvConfig();

const prisma = new PrismaClient();
const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY ?? '';
const RAW_STATES = (process.env.LEGISCAN_STATES ?? PRIORITY_STATE_CODES.join(','))
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const STATES =
  RAW_STATES.length === 1 && RAW_STATES[0] === 'ALL' ? [...ALL_US_STATE_CODES] : RAW_STATES;
const SESSIONS_MODE = (process.env.LEGISCAN_SESSIONS ?? 'current').toLowerCase();

/**
 * (2026-07-10 hot-fix) The cost to attribute to ONE session's cursor this
 * run: its own getDataset call (1), plus — ONLY for the first session
 * processed this state-run — the two state-level calls (getSessionList +
 * getDatasetList) that are made once per state, not once per session.
 * Previously a single ever-growing `queries` counter was re-attributed IN
 * FULL to every session's cursor, so a state with N sessions over-counted
 * the aggregate governor total by roughly the state-level cost times
 * (N choose 2) — inflating month-to-date spend and risking a premature
 * quota-governor trip well before the true 30k/mo cap was reached.
 */
export function sessionQueryCost(isFirstSessionThisRun: boolean, stateLevelQueries: number): number {
  return 1 + (isFirstSessionThisRun ? stateLevelQueries : 0);
}

/**
 * (2026-07-10 hot-fix) The queriesUsed write for a cursor already on record:
 * increment when the stored quotaMonth matches the current month, but RESET
 * to just this run's cost on a month rollover — mirrors
 * sync-legiscan-bills.ts's bumpCursorQueries. Previously this always
 * incremented unconditionally, silently carrying a prior month's spend into
 * the current month's tally.
 */
export function nextQueriesUsed(
  existingQuotaMonth: string | null | undefined,
  currentMonth: string,
  queriesForThisCursor: number,
): number | { increment: number } {
  return existingQuotaMonth === currentMonth
    ? { increment: queriesForThisCursor }
    : queriesForThisCursor;
}

async function backfillState(
  state: string,
): Promise<{ bills: number; people: number; votes: number; errors: number; queries: number }> {
  let stateLevelQueries = 0;
  let bills = 0;
  let people = 0;
  let votes = 0;
  let errors = 0;

  const sessions = await getSessionList(LEGISCAN_API_KEY, state);
  stateLevelQueries++;
  if (!sessions.length) {
    console.warn(`[backfill-legiscan] ${state}: no sessions returned`);
    return { bills, people, votes, errors, queries: stateLevelQueries };
  }
  for (const session of sessions) {
    await upsertStateSession(prisma, state, session);
  }

  const targetSessions = sessions.filter((s) => (SESSIONS_MODE === 'all' ? true : s.prior !== 1));
  const datasetList = await getDatasetList(LEGISCAN_API_KEY, state);
  stateLevelQueries++;

  // Attributed to the FIRST session's cursor this run only (2026-07-10
  // hot-fix) — see sessionQueryCost's doc comment.
  let stateLevelCreditAttributed = false;
  let totalQueriesThisRun = 0;

  for (const session of targetSessions) {
    const listing = datasetList.find((d) => d.session_id === session.session_id);
    if (!listing) {
      console.warn(
        `[backfill-legiscan] ${state} session ${session.session_id}: no dataset listing`,
      );
      continue;
    }
    try {
      const dataset = await getDataset(LEGISCAN_API_KEY, listing.session_id, listing.access_key);
      if (!dataset?.zip) {
        console.warn(`[backfill-legiscan] ${state} session ${session.session_id}: empty dataset`);
        continue;
      }
      const parsed = await parseDatasetZip(Buffer.from(dataset.zip, 'base64'));
      if (parsed.skipped.bills || parsed.skipped.people || parsed.skipped.votes) {
        console.warn(
          `[backfill-legiscan] ${state} session ${session.session_id}: skipped ${JSON.stringify(parsed.skipped)} (see legiscan-dataset.util.ts wrapper-key note)`,
        );
      }

      const billHashes: Record<string, string> = {};
      const billIdToKey = new Map<number, string>();
      for (const raw of parsed.bills) {
        try {
          const normalized = normalizeLegiscanBill(raw, state);
          if (!normalized) {
            errors++;
            continue;
          }
          await upsertNormalizedStateBill(prisma, normalized);
          await crosswalkStateBill(prisma, normalized.billKey, normalized.legiscanBillId);
          billHashes[String(raw.bill_id)] = raw.change_hash;
          billIdToKey.set(raw.bill_id, normalized.billKey);
          bills++;
        } catch (err) {
          errors++;
          console.error(`[backfill-legiscan] ${state} bill ${raw.bill_id} failed:`, err);
        }
      }

      for (const person of parsed.people) {
        try {
          if (await crosswalkLegiscanPerson(prisma, state, person)) people++;
        } catch (err) {
          errors++;
          console.error(`[backfill-legiscan] ${state} person ${person.people_id} failed:`, err);
        }
      }

      for (const vote of parsed.votes) {
        try {
          const billKey = vote.bill_id ? (billIdToKey.get(vote.bill_id) ?? null) : null;
          await upsertStateRollCallVote(prisma, state, billKey, vote);
          votes++;
        } catch (err) {
          errors++;
          console.error(`[backfill-legiscan] ${state} roll call ${vote.roll_call_id} failed:`, err);
        }
      }

      // 2026-07-10 hot-fix: this session's OWN cost, plus the state-level
      // cost (getSessionList + getDatasetList) attributed ONCE to the first
      // session that reaches this point this run — never the previous
      // ever-growing cumulative `queries` counter re-attributed in full to
      // every session (see sessionQueryCost's doc comment).
      const queriesForThisCursor = sessionQueryCost(!stateLevelCreditAttributed, stateLevelQueries);
      stateLevelCreditAttributed = true;
      totalQueriesThisRun += queriesForThisCursor;

      const cursorId = `${state}-${session.session_id}`;
      const month = currentQuotaMonth();
      const existingCursor = await prisma.stateSyncCursor.findUnique({
        where: { id: cursorId },
        select: { quotaMonth: true },
      });
      if (existingCursor) {
        await prisma.stateSyncCursor.update({
          where: { id: cursorId },
          data: {
            billHashes,
            queriesUsed: nextQueriesUsed(existingCursor.quotaMonth, month, queriesForThisCursor),
            quotaMonth: month,
            lastListAt: new Date(),
            lastDrainAt: new Date(),
          },
        });
      } else {
        await prisma.stateSyncCursor.create({
          data: {
            id: cursorId,
            state,
            sessionId: session.session_id,
            sessionKey: normalizeSessionKeyFor(session),
            billHashes,
            queriesUsed: queriesForThisCursor,
            quotaMonth: month,
            lastListAt: new Date(),
            lastDrainAt: new Date(),
          },
        });
      }
    } catch (err) {
      errors++;
      console.error(
        `[backfill-legiscan] ${state} session ${session.session_id} dataset failed:`,
        err,
      );
    }
  }

  await backfillStateBillLinkTargets(prisma);
  return { bills, people, votes, errors, queries: totalQueriesThisRun };
}

function normalizeSessionKeyFor(session: {
  year_start: number;
  special: 0 | 1;
  session_id: number;
}): string {
  return session.special === 1
    ? `${session.year_start}x${session.session_id}`
    : `${session.year_start}`;
}

async function main() {
  if (!LEGISCAN_API_KEY) throw new Error('LEGISCAN_API_KEY env var is required');
  console.log(`[backfill-legiscan] states: ${STATES.join(', ')} (sessions=${SESSIONS_MODE})`);

  await runWithSyncRun(prisma as never, 'backfill-legiscan-datasets', async () => {
    // 2026-07-10 hot-fix: gate on the TRUE hard cap, not sync-legiscan-bills'
    // conservative soft budget — this script is the explicit cheap fallback
    // for when that soft budget trips (see header comment), so it must keep
    // running past it; only the real LegiScan ceiling stops it.
    const month = currentQuotaMonth();
    const allCursors = await prisma.stateSyncCursor.findMany({
      select: { queriesUsed: true, quotaMonth: true },
    });
    const usedThisMonth = monthToDateQueries(allCursors, month);
    if (quotaExhausted(usedThisMonth, LEGISCAN_HARD_CAP)) {
      console.log(
        `INGESTION_SKIP ${JSON.stringify({ source: 'backfill-legiscan-datasets', reason: 'quota', usedThisMonth, budget: LEGISCAN_HARD_CAP })}`,
      );
      return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
    }

    let bills = 0;
    let people = 0;
    let votes = 0;
    let errors = 0;

    for (const state of STATES) {
      const r = await backfillState(state);
      bills += r.bills;
      people += r.people;
      votes += r.votes;
      errors += r.errors;
      console.log(
        `[backfill-legiscan] ${state}: +${r.bills} bills, +${r.people} people, +${r.votes} votes, ${r.errors} errors, ${r.queries} queries`,
      );
    }

    console.log(
      `[backfill-legiscan] DONE: ${bills} bills, ${people} people, ${votes} votes, ${errors} errors`,
    );
    return { inserted: bills + people + votes, updated: 0, skipped: 0, errors };
  });
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
