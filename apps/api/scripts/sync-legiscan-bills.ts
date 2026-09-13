/**
 * LegiScan bill drain (State Legislation Platform, Phase 0 S1.3.3). Pops up
 * to `LEGISCAN_DRAIN_CAP` bill_ids round-robin across all states' pending
 * queues (`state_sync_cursor.pendingBills`) so one busy state can't starve the
 * others, `getBill` each, normalize+upsert (legiscan-normalize.ts), and
 * bounded revision-aware `getRollCall` refresh through the same quota owner.
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
import {
  getBill,
  getRollCall,
  getBillText,
  getSupportingDocument,
} from '../src/external/legiscan/legiscan.client.js';
import { queueEventRecordRefresh } from '../src/ingestion/legiwatch-event-record-refresh.js';
import { PRIORITY_STATE_CODES } from '../src/external/legiscan/us-states.js';
import { persistPublishedRecords } from '../src/ingestion/legiscan-published-records.js';
import { queueLegiWatchReportRefresh } from '../src/ingestion/legiwatch-report-refresh.js';
import { voteNeedsRefresh } from '../src/ingestion/legiscan-vote-revisions.js';
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

    if (process.env.LEGISCAN_REPORT_REFRESH_TENANT) {
      const refresh = await queueLegiWatchReportRefresh(
        prisma,
        process.env.LEGISCAN_REPORT_REFRESH_TENANT,
        STATES,
      );
      console.log(`REPORT_SOURCE_REFRESH ${JSON.stringify(refresh)}`);
    }
    if (process.env.LEGIWATCH_PUBLISHED_RECORD_REFRESH_ENABLED === 'true')
      await queueEventRecordRefresh(prisma, STATES);
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
    let requestsThisRun = 0;
    let voteRequests = 0;
    let documentRequests = 0;
    const documentCap = Math.max(
      1,
      Math.min(100, Number(process.env.LEGISCAN_DOCUMENT_REFRESH_CAP) || 10),
    );
    const voteCap = Math.max(
      1,
      Math.min(1000, Number(process.env.LEGISCAN_VOTE_REFRESH_CAP) || 200),
    );
    const retries = new Map<string, number[]>();

    drainLoop: while (drained < DRAIN_CAP) {
      let madeProgress = false;
      for (const [cursorId, queue] of queues) {
        if (drained >= DRAIN_CAP || usedThisMonth + requestsThisRun >= MONTHLY_BUDGET)
          break drainLoop;
        const billId = queue.ids.shift();
        if (billId === undefined) continue;
        madeProgress = true;
        drained++;
        let queriesForBill = 0;
        const countRetry = () => {
          if (usedThisMonth + requestsThisRun >= MONTHLY_BUDGET)
            throw Error('LEGISCAN_MONTHLY_BUDGET_EXHAUSTED');
          queriesForBill++;
          requestsThisRun++;
        };

        try {
          await prisma.stateBill.updateMany({
            where: { legiscanBillId: billId },
            data: {
              sourceCheckAttemptedAt: new Date(),
              sourceCheckStatus: 'pending',
              sourceCheckError: null,
            },
          });
          queriesForBill++;
          requestsThisRun++;
          const raw = await getBill(LEGISCAN_API_KEY, billId, countRetry);
          if (!raw) {
            errors++;
            await prisma.stateBill.updateMany({
              where: { legiscanBillId: billId },
              data: { sourceCheckStatus: 'failed', sourceCheckError: 'Provider returned no bill' },
            });
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
            await prisma.stateBill.updateMany({
              where: { legiscanBillId: billId },
              data: {
                sourceCheckStatus: 'failed',
                sourceCheckError: 'Canonical bill identity did not validate',
              },
            });
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
          await persistPublishedRecords(prisma, normalized.billKey, raw);
          await crosswalkStateBill(prisma, normalized.billKey, normalized.legiscanBillId);
          if (isNew) inserted++;
          else updated++;

          // Same provider transport/quota owner, separately qualified source-content gate.
          if (process.env.LEGISCAN_DOCUMENT_EVIDENCE_ENABLED === 'true') {
            const { persistDocumentEvidence } =
              await import('../src/ingestion/legiscan-document-evidence.js');
            const documents = [
              ...(raw.texts ?? []).map((s) => ({
                id: s.doc_id,
                kind: 'text' as const,
                hash: s.text_hash,
              })),
              ...(raw.amendments ?? []).map((s) => ({
                id: s.amendment_id,
                kind: 'amendment' as const,
                hash: s.amendment_hash,
              })),
              ...(raw.supplements ?? []).map((s) => ({
                id: s.supplement_id,
                kind: 'supplement' as const,
                hash: s.supplement_hash,
              })),
            ];
            for (const stub of documents) {
              const identity = `${stub.kind}:${stub.id}`;
              const checks = await prisma.$queryRaw<
                Array<{ providerHash: string | null; next: Date | null }>
              >`
                SELECT provider_hash AS "providerHash",next_check_at AS next FROM state_bill_record_check
                WHERE bill_key=${normalized.billKey} AND kind='document' AND source_identity=${identity}`;
              if (
                checks[0]?.providerHash === (stub.hash ?? null) &&
                checks[0]?.next &&
                checks[0].next > new Date()
              )
                continue;
              if (
                documentRequests >= documentCap ||
                usedThisMonth + requestsThisRun >= MONTHLY_BUDGET
              ) {
                retries.set(cursorId, [...(retries.get(cursorId) ?? []), billId]);
                break;
              }
              await prisma.$executeRaw`INSERT INTO state_bill_record_check(bill_key,kind,source_identity,state,attempted_at,attempts)
                VALUES(${normalized.billKey},'document',${identity},'pending',now(),1)
                ON CONFLICT(bill_key,kind,source_identity) DO UPDATE SET state='pending',attempted_at=now(),attempts=state_bill_record_check.attempts+1`;
              try {
                documentRequests++;
                queriesForBill++;
                requestsThisRun++;
                const doc =
                  stub.kind === 'text'
                    ? await getBillText(LEGISCAN_API_KEY, stub.id, countRetry)
                    : await getSupportingDocument(LEGISCAN_API_KEY, stub.kind, stub.id, countRetry);
                if (!doc) throw Error('DOCUMENT_UNAVAILABLE');
                if (doc.doc_id !== stub.id || doc.bill_id !== raw.bill_id)
                  throw Error('DOCUMENT_SUBJECT_MISMATCH');
                const state = await persistDocumentEvidence(
                  prisma,
                  normalized.billKey,
                  doc,
                  stub.kind === 'text'
                    ? undefined
                    : { id: stub.id, kind: stub.kind, billId: raw.bill_id },
                );
                await prisma.$executeRaw`UPDATE state_bill_record_check SET state=${state === 'extracted' ? 'available' : 'partial'},
                  checked_at=now(),next_check_at=now()+interval '7 days',error_code=NULL,provider_hash=${stub.hash ?? null}
                  WHERE bill_key=${normalized.billKey} AND kind='document' AND source_identity=${identity}`;
              } catch {
                errors++;
                await prisma.$executeRaw`UPDATE state_bill_record_check SET state='failed',error_code='DOCUMENT_RETRIEVAL_OR_EXTRACTION_FAILED',
                  next_check_at=now()+least(interval '3 days',interval '3 hours'*power(2,least(attempts,4)))
                  WHERE bill_key=${normalized.billKey} AND kind='document' AND source_identity=${identity}`;
              }
            }
          }

          // A failed getRollCall must NOT let the bill's hash advance below —
          // otherwise the next masterlist diff sees a hash that already
          // matches LegiScan's and never re-queues the bill, permanently
          // losing that vote (2026-07-10 hot-fix). Tracked per-bill so ONE
          // failed roll call blocks the advance even when sibling votes
          // succeeded.
          let voteFetchFailed = !Array.isArray(raw.votes);
          for (const stub of raw.votes ?? []) {
            const existing = await prisma.stateRollCallVote.findUnique({
              where: { id: stateRollCallId(queue.state, stub.roll_call_id) },
              select: { currentRevisionHash: true, providerBillHash: true, lastSyncedAt: true },
            });
            if (!voteNeedsRefresh(existing, raw.change_hash)) continue;
            if (voteRequests >= voteCap || usedThisMonth + requestsThisRun >= MONTHLY_BUDGET) {
              voteFetchFailed = true;
              break;
            }
            try {
              queriesForBill++;
              requestsThisRun++;
              voteRequests++;
              const rollCall = await getRollCall(LEGISCAN_API_KEY, stub.roll_call_id, countRetry);
              if (rollCall)
                await upsertStateRollCallVote(prisma, queue.state, normalized.billKey, rollCall, {
                  stub,
                  providerBillHash: raw.change_hash,
                  providerBillId: raw.bill_id,
                });
              else {
                errors++;
                voteFetchFailed = true;
              }
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
            retries.set(cursorId, [...(retries.get(cursorId) ?? []), billId]);
            await prisma.stateBill.updateMany({
              where: { legiscanBillId: billId },
              data: {
                sourceCheckStatus: 'partial',
                sourceCheckError: 'One or more vote records could not be checked',
              },
            });
            await prisma.stateSyncCursor.update({
              where: { id: cursorId },
              data: { pendingBills: { set: queue.ids } },
            });
            await bumpCursorQueries(cursorId, queriesForBill);
            continue;
          }
          const cursor = await prisma.stateSyncCursor.findUnique({ where: { id: cursorId } });
          await prisma.stateBill.updateMany({
            where: { legiscanBillId: billId },
            data: {
              sourceCheckedAt: new Date(),
              sourceCheckStatus: 'success',
              sourceCheckError: null,
            },
          });
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
          await prisma.stateBill.updateMany({
            where: { legiscanBillId: billId },
            data: {
              sourceCheckStatus: 'failed',
              sourceCheckError: 'Source check or ingestion failed; retry pending',
            },
          });
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

    // Keep incomplete bills queued even when their master-list hash is unchanged.
    // A retry is for the next scheduled invocation; no tight in-run fetch loop.
    for (const [cursorId, ids] of retries) {
      const current = await prisma.stateSyncCursor.findUnique({ where: { id: cursorId } });
      await prisma.stateSyncCursor.update({
        where: { id: cursorId },
        data: { pendingBills: { set: [...new Set([...(current?.pendingBills ?? []), ...ids])] } },
      });
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
