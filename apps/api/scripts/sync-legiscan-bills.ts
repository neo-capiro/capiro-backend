/**
 * LegiScan bill drain (State Legislation Platform, Phase 0 S1.3.3). Pops up
 * to `LEGISCAN_DRAIN_CAP` bill_ids round-robin across all states' pending
 * queues (`state_sync_cursor.pendingBills`) so one busy state can't starve the
 * others, `getBill` each, normalize+upsert (legiscan-normalize.ts), and
 * `getRollCall` for each vote stub the payload carries — skipped when
 * state_roll_call_vote already has that legiscan_roll_call_id with matching
 * totals (votes are immutable once recorded).
 *
 * Quota governor: stops (INGESTION_SKIP, exit 0) once month-to-date
 * queriesUsed across all cursors reaches LEGISCAN_MONTHLY_BUDGET — the
 * fallback is `backfill-legiscan-datasets` (weekly dataset refresh, ~2
 * queries/state) for the states left undrained that month.
 *
 * billHashes is updated ONLY after a bill's drain succeeds (see
 * sync-legiscan-masterlist.ts's header comment for why: updating optimistically
 * at diff-time would let a mid-drain crash silently lose the change).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/sync-legiscan-bills.ts
 * Env: LEGISCAN_API_KEY (required), LEGISCAN_STATES (CSV, default the 8
 *      priority states, matching whichever masterlist rule fed the queue),
 *      LEGISCAN_DRAIN_CAP (default 400), LEGISCAN_MONTHLY_BUDGET (default
 *      28000 — headroom under LegiScan's free-tier 30k/mo hard cap).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { getBill, getRollCall } from '../src/external/legiscan/legiscan.client.js';
import { PRIORITY_STATE_CODES } from '../src/external/legiscan/us-states.js';
import {
  normalizeLegiscanBill,
  upsertNormalizedStateBill,
  upsertStateRollCallVote,
  crosswalkStateBill,
  stateRollCallId,
} from '../src/ingestion/legiscan-normalize.js';
import {
  currentQuotaMonth,
  monthToDateQueries,
  quotaExhausted,
} from '../src/ingestion/legiscan-quota.util.js';
dotenvConfig();

const prisma = new PrismaClient();
const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY ?? '';
const STATES = (process.env.LEGISCAN_STATES ?? PRIORITY_STATE_CODES.join(','))
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const DRAIN_CAP = Number(process.env.LEGISCAN_DRAIN_CAP ?? '400');
const MONTHLY_BUDGET = Number(process.env.LEGISCAN_MONTHLY_BUDGET ?? '28000');

/** Add `delta` to a cursor's month-to-date query counter, rolling over on a calendar-month change. */
async function bumpCursorQueries(cursorId: string, delta: number): Promise<void> {
  const month = currentQuotaMonth();
  const cursor = await prisma.stateSyncCursor.findUnique({
    where: { id: cursorId },
    select: { quotaMonth: true },
  });
  if (cursor?.quotaMonth === month) {
    await prisma.stateSyncCursor.update({
      where: { id: cursorId },
      data: { queriesUsed: { increment: delta } },
    });
  } else {
    await prisma.stateSyncCursor.update({
      where: { id: cursorId },
      data: { queriesUsed: delta, quotaMonth: month },
    });
  }
}

/** Exported for the getRollCall-failure regression spec (mocks prisma + the legiscan/normalize modules). */
export async function main() {
  if (!LEGISCAN_API_KEY) throw new Error('LEGISCAN_API_KEY env var is required');

  await runWithSyncRun(prisma as never, 'sync-legiscan-bills', async () => {
    const month = currentQuotaMonth();
    const allCursors = await prisma.stateSyncCursor.findMany({
      select: { queriesUsed: true, quotaMonth: true },
    });
    const usedThisMonth = monthToDateQueries(allCursors, month);
    if (quotaExhausted(usedThisMonth, MONTHLY_BUDGET)) {
      console.log(
        `INGESTION_SKIP ${JSON.stringify({ source: 'sync-legiscan-bills', reason: 'quota', usedThisMonth, budget: MONTHLY_BUDGET })}`,
      );
      return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
    }

    const cursors = await prisma.stateSyncCursor.findMany({
      where: { state: { in: STATES }, pendingBills: { isEmpty: false } },
    });
    const queues = new Map<string, { state: string; ids: number[] }>(
      cursors.map((c) => [c.id, { state: c.state, ids: [...(c.pendingBills as number[])] }]),
    );

    let inserted = 0;
    let updated = 0;
    let errors = 0;
    let drained = 0;

    drainLoop: while (drained < DRAIN_CAP) {
      let madeProgress = false;
      for (const [cursorId, queue] of queues) {
        if (drained >= DRAIN_CAP) break drainLoop;
        const billId = queue.ids.shift();
        if (billId === undefined) continue;
        madeProgress = true;
        drained++;
        let queriesForBill = 0;

        try {
          const raw = await getBill(LEGISCAN_API_KEY, billId);
          queriesForBill++;
          if (!raw) {
            errors++;
            await prisma.stateSyncCursor.update({
              where: { id: cursorId },
              data: { pendingBills: { set: queue.ids } },
            });
            await bumpCursorQueries(cursorId, queriesForBill);
            continue;
          }

          const normalized = normalizeLegiscanBill(raw, queue.state);
          if (!normalized) {
            errors++;
            console.error(
              `[sync-legiscan-bills] ${queue.state} bill ${billId}: DD1 key failed validation`,
            );
            await prisma.stateSyncCursor.update({
              where: { id: cursorId },
              data: { pendingBills: { set: queue.ids } },
            });
            await bumpCursorQueries(cursorId, queriesForBill);
            continue;
          }

          const { isNew } = await upsertNormalizedStateBill(prisma, normalized);
          await crosswalkStateBill(prisma, normalized.billKey, normalized.legiscanBillId);
          if (isNew) inserted++;
          else updated++;

          // A failed getRollCall must NOT let the bill's hash advance below —
          // otherwise the next masterlist diff sees a hash that already
          // matches LegiScan's and never re-queues the bill, permanently
          // losing that vote (2026-07-10 hot-fix). Tracked per-bill so ONE
          // failed roll call blocks the advance even when sibling votes
          // succeeded.
          let voteFetchFailed = false;
          for (const stub of raw.votes ?? []) {
            const existing = await prisma.stateRollCallVote.findUnique({
              where: { id: stateRollCallId(queue.state, stub.roll_call_id) },
              select: { yeas: true, nays: true, nv: true, absent: true },
            });
            const totalsMatch =
              existing &&
              existing.yeas === (stub.yea ?? 0) &&
              existing.nays === (stub.nay ?? 0) &&
              existing.nv === (stub.nv ?? 0) &&
              existing.absent === (stub.absent ?? 0);
            if (totalsMatch) continue; // votes are immutable once recorded — skip the refetch
            try {
              const rollCall = await getRollCall(LEGISCAN_API_KEY, stub.roll_call_id);
              queriesForBill++;
              if (rollCall)
                await upsertStateRollCallVote(prisma, queue.state, normalized.billKey, rollCall);
            } catch (err) {
              errors++;
              voteFetchFailed = true;
              console.error(
                `[sync-legiscan-bills] ${queue.state} roll call ${stub.roll_call_id} failed:`,
                err,
              );
            }
          }

          // Only advance the hash-cache AFTER a fully successful drain (see
          // header comment — a crash before this point re-queues on the next
          // masterlist diff instead of silently losing the change). A failed
          // vote fetch is treated exactly like the getBill-null / DD1-invalid
          // paths above: pendingBills still drains this billId for THIS run
          // (no busy-loop retry within the same invocation), but billHashes
          // is left stale so the NEXT masterlist diff detects the mismatch
          // and re-queues the bill for a fresh drain.
          if (voteFetchFailed) {
            await prisma.stateSyncCursor.update({
              where: { id: cursorId },
              data: { pendingBills: { set: queue.ids } },
            });
            await bumpCursorQueries(cursorId, queriesForBill);
            continue;
          }
          const cursor = await prisma.stateSyncCursor.findUnique({ where: { id: cursorId } });
          const billHashes = {
            ...((cursor?.billHashes as Record<string, string> | undefined) ?? {}),
          };
          billHashes[String(billId)] = raw.change_hash;
          await prisma.stateSyncCursor.update({
            where: { id: cursorId },
            data: { billHashes, pendingBills: { set: queue.ids } },
          });
          await bumpCursorQueries(cursorId, queriesForBill);
        } catch (err) {
          errors++;
          console.error(`[sync-legiscan-bills] ${queue.state} bill ${billId} failed:`, err);
          await prisma.stateSyncCursor.update({
            where: { id: cursorId },
            data: { pendingBills: { set: queue.ids } },
          });
          await bumpCursorQueries(cursorId, queriesForBill);
        }
      }
      if (!madeProgress) break;
    }

    console.log(
      `[sync-legiscan-bills] drained ${drained} bills: +${inserted} new, ~${updated} updated, ${errors} errors`,
    );
    return { inserted, updated, skipped: 0, errors };
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
