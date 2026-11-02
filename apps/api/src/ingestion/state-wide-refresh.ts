import type { PrismaClient } from '@prisma/client';
import { ALL_US_STATE_CODES, PRIORITY_STATE_CODES } from '../external/legiscan/us-states.js';
import { getMasterListRaw } from '../external/legiscan/legiscan.client.js';
import { withLegiscanApiAllowed } from './legiscan-provider-capacity.js';
import { LegiscanProviderCapacityError } from '../external/legiscan/legiscan-capacity.js';
import { reservedLegiscanQuery } from './legiscan-query-reservation.js';
import { loadPinnedStateInventory } from './state-bill-inventory-read.js';

export const WIDE_FY26_STATES = ALL_US_STATE_CODES.filter(
  (state) => !(PRIORITY_STATE_CODES as readonly string[]).includes(state),
);
export type KnownParent = { state: string; sessionId: number; providerId: number; billKey: string };
/** Only actual canonical parents matching an exact admitted frozen inventory
 * enter the wide API queue. Unknown/unimported/excluded parents never consume a
 * speculative getBill call. Their discovery remains the bulk refresh owner's. */
export async function knownFrozenFy26Parents(prisma: PrismaClient): Promise<KnownParent[]> {
  const pinned = await loadPinnedStateInventory(prisma);
  const states = pinned.inventories
    .filter((row) => row.known && WIDE_FY26_STATES.includes(row.jurisdiction as any))
    .map((row) => row.jurisdiction);
  if (!states.length || !pinned.qualifiedReceiptIds.length) return [];
  return prisma.$queryRawUnsafe<KnownParent[]>(
    `SELECT DISTINCT upper(b.state) AS state,(r.scope->>'providerSessionId')::int AS "sessionId",
    b.legiscan_bill_id AS "providerId",b.id AS "billKey" FROM legal_source_receipt r
    CROSS JOIN LATERAL jsonb_array_elements(r.manifest->'bills') p
    JOIN state_bill b ON b.id=p->>'billKey' AND b.legiscan_bill_id::text=p->>'providerBillId'
    WHERE r.id=ANY($1::text[]) AND upper(b.state)=ANY($2::text[]) AND upper(b.state)=r.scope->>'jurisdiction'
      AND b.session_key=r.scope->>'sessionKey'`,
    pinned.qualifiedReceiptIds,
    states,
  );
}
export function knownParentDiff(
  masterlist: Array<{ bill_id: number; change_hash: string }>,
  known: ReadonlySet<number>,
  hashes: Record<string, string>,
  pending: ReadonlySet<number>,
) {
  return masterlist
    .filter(
      (row) =>
        known.has(row.bill_id) &&
        hashes[String(row.bill_id)] !== undefined &&
        hashes[String(row.bill_id)] !== row.change_hash &&
        !pending.has(row.bill_id),
    )
    .map((row) => row.bill_id);
}
export function wideListDue(lastListAt: Date | null | undefined, now = Date.now()) {
  return !lastListAt || now - lastListAt.getTime() >= 24 * 3600_000;
}
export async function refreshKnownFy26Wide(prisma: PrismaClient, apiKey: string) {
  const known = await knownFrozenFy26Parents(prisma);
  let queries = 0,
    queued = 0,
    errors = 0;
  for (const state of WIDE_FY26_STATES) {
    const parents = known.filter((row) => row.state === state);
    if (!parents.length) continue;
    for (const sessionId of [...new Set(parents.map((row) => row.sessionId))]) {
      const cursorId = `${state}-${sessionId}`,
        cursor = await prisma.stateSyncCursor.findUnique({ where: { id: cursorId } });
      if (!cursor || !wideListDue(cursor.lastListAt)) continue;
      const attempted = await prisma.$queryRawUnsafe<Array<{ at: Date | null }>>(
        `SELECT max(observed_at) AS at FROM legal_source_receipt
        WHERE source='legiscan-research-query-reservation' AND scope->>'jurisdiction'=$1 AND manifest->>'operation'='getMasterListRaw'
        AND manifest->>'providerId'=$2`,
        state,
        String(sessionId),
      );
      if (!wideListDue(attempted[0]?.at)) continue;
      try {
        const result = await withLegiscanApiAllowed(prisma, apiKey, () =>
          reservedLegiscanQuery(
            prisma,
            { state, cursorId, operation: 'getMasterListRaw', providerId: sessionId },
            (retry) => getMasterListRaw(apiKey, sessionId, undefined, retry),
          ),
        );
        queries += result.attempts;
        const pending = new Set(cursor.pendingBills);
        const toQueue = knownParentDiff(
          result.value,
          new Set(
            parents.filter((row) => row.sessionId === sessionId).map((row) => row.providerId),
          ),
          cursor.billHashes as Record<string, string>,
          pending,
        );
        for (const id of toQueue) pending.add(id);
        await prisma.stateSyncCursor.update({
          where: { id: cursorId },
          data: { pendingBills: [...pending], lastListAt: new Date() },
        });
        queued += toQueue.length;
      } catch (error) {
        if (error instanceof LegiscanProviderCapacityError)
          return { queries, queued, errors, budgetHeld: true, reason: error.message };
        if (error instanceof Error && error.message === 'EXISTING_PROVIDER_BUDGET_HOLD')
          return { queries, queued, errors, budgetHeld: true };
        errors++;
        // Failed requests stay charged by the reservation owner; leave the
        // successful-list timestamp unchanged so the next invocation retries.
      }
    }
  }
  return { queries, queued, errors, budgetHeld: false };
}
