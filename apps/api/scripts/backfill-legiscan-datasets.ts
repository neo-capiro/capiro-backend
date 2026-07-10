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

function currentQuotaMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

async function backfillState(
  state: string,
): Promise<{ bills: number; people: number; votes: number; errors: number; queries: number }> {
  let queries = 0;
  let bills = 0;
  let people = 0;
  let votes = 0;
  let errors = 0;

  const sessions = await getSessionList(LEGISCAN_API_KEY, state);
  queries++;
  if (!sessions.length) {
    console.warn(`[backfill-legiscan] ${state}: no sessions returned`);
    return { bills, people, votes, errors, queries };
  }
  for (const session of sessions) {
    await upsertStateSession(prisma, state, session);
  }

  const targetSessions = sessions.filter((s) => (SESSIONS_MODE === 'all' ? true : s.prior !== 1));
  const datasetList = await getDatasetList(LEGISCAN_API_KEY, state);
  queries++;

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
      queries++;
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

      const cursorId = `${state}-${session.session_id}`;
      await prisma.stateSyncCursor.upsert({
        where: { id: cursorId },
        create: {
          id: cursorId,
          state,
          sessionId: session.session_id,
          sessionKey: normalizeSessionKeyFor(session),
          billHashes,
          queriesUsed: queries,
          quotaMonth: currentQuotaMonth(),
          lastListAt: new Date(),
          lastDrainAt: new Date(),
        },
        update: {
          billHashes,
          queriesUsed: { increment: queries },
          quotaMonth: currentQuotaMonth(),
          lastListAt: new Date(),
          lastDrainAt: new Date(),
        },
      });
    } catch (err) {
      errors++;
      console.error(
        `[backfill-legiscan] ${state} session ${session.session_id} dataset failed:`,
        err,
      );
    }
  }

  await backfillStateBillLinkTargets(prisma);
  return { bills, people, votes, errors, queries };
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
