/**
 * LegiScan masterlist diff — cheap change detection (State Legislation
 * Platform, Phase 0 S1.3.2). Per state: refresh the session list at most
 * weekly (cached via state_session freshness), then getMasterListRaw per
 * active (non-prior) session, diff change_hash against the cursor's LAST
 * SUCCESSFULLY-DRAINED hash, and append changed bill_ids to the drain queue
 * (`state_sync_cursor.pendingBills`, deduped). Cheap: 1-3 queries/state/run.
 *
 * Deliberately does NOT update billHashes itself — that happens only after
 * sync-legiscan-bills successfully drains a bill. If it updated the hash here
 * (optimistically, before the drain runs), a crash between this diff and the
 * drain would make the NEXT masterlist diff see "already matches" and silently
 * drop the change — the one failure mode "hash-cache loss is harmless" does
 * NOT cover. Leaving the old hash in place until a successful drain makes the
 * whole pipeline self-healing on crash, at the cost of a possible harmless
 * re-queue (idempotent, deduped by the `pending.has()` check below).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/sync-legiscan-masterlist.ts
 * Env: LEGISCAN_API_KEY (required), LEGISCAN_STATES (CSV, default the 8
 *      priority states — the wide sweep for the other 43 runs as a separate
 *      schedule row with LEGISCAN_STATES set to the rest).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { getSessionList, getMasterListRaw } from '../src/external/legiscan/legiscan.client.js';
import { PRIORITY_STATE_CODES } from '../src/external/legiscan/us-states.js';
import { upsertStateSession } from '../src/ingestion/legiscan-normalize.js';
import {
  currentQuotaMonth,
  monthToDateQueries,
  quotaExhausted,
  LEGISCAN_HARD_CAP,
} from '../src/ingestion/legiscan-quota.util.js';
dotenvConfig();

const prisma = new PrismaClient();
const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY ?? '';
const STATES = (process.env.LEGISCAN_STATES ?? PRIORITY_STATE_CODES.join(','))
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const SESSION_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

export interface MasterlistDiffItem {
  bill_id: number;
  change_hash: string;
}

export interface MasterlistDiffResult {
  /** True when the cursor has no billHashes yet (never backfilled) and the
   * masterlist is non-trivial — the diff was skipped entirely. */
  unprimed: boolean;
  toQueue: number[];
}

/**
 * Decide which bill_ids a masterlist diff should queue for drain — or skip
 * entirely when the cursor is un-primed (2026-07-10 hot-fix). A
 * never-backfilled cursor has an EMPTY billHashes map, so every bill in a
 * non-trivial masterlist would otherwise read as "changed," queuing the
 * ENTIRE session for an expensive bill-by-bill getBill/getRollCall drain
 * instead of the cheap bulk-dataset backfill this architecture depends on
 * (header comment: backfill-first is mandatory, masterlist-first burns
 * months of quota). Pure and exported for testability.
 */
export function diffMasterlist(
  masterlist: MasterlistDiffItem[],
  billHashes: Record<string, string>,
  alreadyPending: ReadonlySet<number>,
): MasterlistDiffResult {
  if (Object.keys(billHashes).length === 0 && masterlist.length > 0) {
    return { unprimed: true, toQueue: [] };
  }
  const toQueue: number[] = [];
  for (const item of masterlist) {
    const known = billHashes[String(item.bill_id)];
    if (known !== item.change_hash && !alreadyPending.has(item.bill_id)) {
      toQueue.push(item.bill_id);
    }
  }
  return { unprimed: false, toQueue };
}

/** Refresh the session list at most weekly (freshness read off state_session.lastSyncedAt). Returns [sessions, queriesSpent]. */
async function activeSessions(
  state: string,
): Promise<[Awaited<ReturnType<typeof prisma.stateSession.findMany>>, number]> {
  const existing = await prisma.stateSession.findMany({ where: { state, prior: false } });
  const now = Date.now();
  const fresh =
    existing.length > 0 &&
    existing.every((s) => now - s.lastSyncedAt.getTime() < SESSION_REFRESH_MS);
  if (fresh) return [existing, 0];

  const sessions = await getSessionList(LEGISCAN_API_KEY, state);
  for (const s of sessions) await upsertStateSession(prisma, state, s);
  const refreshed = await prisma.stateSession.findMany({ where: { state, prior: false } });
  return [refreshed, 1];
}

async function main() {
  if (!LEGISCAN_API_KEY) throw new Error('LEGISCAN_API_KEY env var is required');

  await runWithSyncRun(prisma as never, 'sync-legiscan-masterlist', async () => {
    // 2026-07-10 hot-fix: gate on the TRUE hard cap, not sync-legiscan-bills'
    // conservative soft budget — this diff is cheap (1-3 queries/state) and
    // must keep running even when the drain has backed off; only the real
    // LegiScan ceiling stops it (see legiscan-quota.util.ts).
    const month = currentQuotaMonth();
    const allCursors = await prisma.stateSyncCursor.findMany({
      select: { queriesUsed: true, quotaMonth: true },
    });
    const usedThisMonth = monthToDateQueries(allCursors, month);
    if (quotaExhausted(usedThisMonth, LEGISCAN_HARD_CAP)) {
      console.log(
        `INGESTION_SKIP ${JSON.stringify({ source: 'sync-legiscan-masterlist', reason: 'quota', usedThisMonth, budget: LEGISCAN_HARD_CAP })}`,
      );
      return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
    }

    let queued = 0;
    let errors = 0;
    let totalQueries = 0;

    for (const state of STATES) {
      try {
        const [sessions, sessionListQueries] = await activeSessions(state);
        totalQueries += sessionListQueries;
        // Attribute the (rare, weekly) getSessionList call to the first
        // session's cursor row — an approximation; the monthly budget
        // governor only needs an accurate AGGREGATE, not per-session billing.
        let attributedSessionListQueries = sessionListQueries;

        for (const session of sessions) {
          const cursorId = `${state}-${session.legiscanSessionId}`;
          const cursor = await prisma.stateSyncCursor.findUnique({ where: { id: cursorId } });
          const billHashes = (cursor?.billHashes as Record<string, string> | undefined) ?? {};
          const pending = new Set<number>((cursor?.pendingBills as number[] | undefined) ?? []);

          const masterlist = await getMasterListRaw(LEGISCAN_API_KEY, session.legiscanSessionId);
          totalQueries += 1;
          const queriesThisSession = 1 + attributedSessionListQueries;
          attributedSessionListQueries = 0;

          const diff = diffMasterlist(masterlist, billHashes, pending);
          if (diff.unprimed) {
            console.warn(
              `[sync-legiscan-masterlist] ${state} session ${session.legiscanSessionId}: cursor has ` +
                `no billHashes yet (never backfilled) but the masterlist returned ${masterlist.length} bills — ` +
                `skipping the bill-by-bill diff to avoid an expensive cold drain. Run ` +
                `backfill-legiscan-datasets for this state/session first.`,
            );
          } else {
            for (const id of diff.toQueue) {
              pending.add(id);
              queued++;
            }
          }

          // LegiScan quota resets monthly — a cursor last touched in a prior
          // calendar month must start this month's count fresh, not keep
          // incrementing last month's total forward.
          const month = currentQuotaMonth();
          const sameMonth = cursor?.quotaMonth === month;
          await prisma.stateSyncCursor.upsert({
            where: { id: cursorId },
            create: {
              id: cursorId,
              state,
              sessionId: session.legiscanSessionId,
              sessionKey: session.sessionKey,
              billHashes,
              pendingBills: [...pending],
              queriesUsed: queriesThisSession,
              quotaMonth: month,
              lastListAt: new Date(),
            },
            update: {
              pendingBills: [...pending],
              queriesUsed: sameMonth ? { increment: queriesThisSession } : queriesThisSession,
              quotaMonth: month,
              lastListAt: new Date(),
            },
          });
        }
      } catch (err) {
        errors++;
        console.error(`[sync-legiscan-masterlist] ${state} failed:`, err);
      }
    }

    console.log(
      `[sync-legiscan-masterlist] queued ${queued} changed bills across ${STATES.length} states (${totalQueries} queries), ${errors} errors`,
    );
    return { inserted: queued, updated: 0, skipped: 0, errors };
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
