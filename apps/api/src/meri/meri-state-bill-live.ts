import type { PrismaClient } from '@prisma/client';
import {
  INTERACTIVE_LEGISCAN_TRANSPORT,
  getBill,
  getMasterListRaw,
  getSessionList,
  type LegiscanBill,
  type LegiscanSession,
} from '../external/legiscan/legiscan.client.js';
import {
  normalizeLegiscanBill,
  upsertNormalizedStateBill,
} from '../ingestion/legiscan-normalize.js';
import {
  LEGISCAN_HARD_CAP,
  currentQuotaMonth,
  monthToDateQueries,
} from '../ingestion/legiscan-quota.util.js';

/**
 * Live LegiScan lookup for one exact state bill designation that the hourly
 * sync has not stored yet (Neo, 2026-10-06). It writes through the sync's own
 * normalizer and upsert, so the tool then answers from the same tables, and it
 * spends the shared monthly LegiScan quota only under the advisory lock the
 * other quota spenders use.
 */

/** Queries one lookup reserves: the session list, up to two masterlists, one bill. */
export const STATE_BILL_LIVE_LOOKUP_COST = 4;
/** Live lookups' own monthly ceiling inside the shared soft budget. */
const DEFAULT_LIVE_MONTHLY_BUDGET = 1_000;
const MAX_SESSIONS = 2;
const MISS_TTL_MS = 60 * 60_000;
const LIVE_CURSOR_PREFIX = 'meri-live-';

const recentMisses = new Map<string, number>();

export type StateBillLiveOutcome =
  | { kind: 'found'; billKey: string }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: 'not_configured' | 'quota' | 'provider_error' };

export interface StateBillLiveDeps {
  apiKey?: string;
  liveMonthlyBudget?: number;
  softBudget?: number;
  now?: () => Date;
  getSessionList?: typeof getSessionList;
  getMasterListRaw?: typeof getMasterListRaw;
  getBill?: typeof getBill;
  persist?: (raw: LegiscanBill, state: string) => Promise<string | null>;
}

function billNumberKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Current sessions, regular before special, newest first. */
export function currentLegiscanSessions(sessions: readonly LegiscanSession[]): LegiscanSession[] {
  return sessions
    .filter((session) => session.prior !== 1)
    .sort(
      (left, right) =>
        Number(left.special) - Number(right.special) ||
        right.year_start - left.year_start ||
        right.session_id - left.session_id,
    )
    .slice(0, MAX_SESSIONS);
}

async function reserveLiveQuota(
  prisma: PrismaClient,
  state: string,
  now: Date,
  liveBudget: number,
  softBudget: number,
): Promise<boolean> {
  const month = currentQuotaMonth(now);
  const cursorId = `${LIVE_CURSOR_PREFIX}${state}`;
  const cost = STATE_BILL_LIVE_LOOKUP_COST;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('legiscan-research-quota',0))`;
    const cursors = await tx.stateSyncCursor.findMany({
      select: { id: true, queriesUsed: true, quotaMonth: true },
    });
    const used = monthToDateQueries(cursors, month);
    const liveUsed = monthToDateQueries(
      cursors.filter((cursor) => cursor.id.startsWith(LIVE_CURSOR_PREFIX)),
      month,
    );
    if (used + cost > softBudget || liveUsed + cost > liveBudget) return false;
    // A dedicated accounting row: sessionId 0 and no pending bills, so the
    // drain and masterlist jobs never treat it as a session to sync.
    await tx.stateSyncCursor.upsert({
      where: { id: cursorId },
      create: {
        id: cursorId,
        state,
        sessionId: 0,
        sessionKey: 'meri-live',
        queriesUsed: 0,
        quotaMonth: month,
      },
      update: {},
    });
    await tx.$executeRaw`UPDATE state_sync_cursor SET queries_used=CASE WHEN quota_month=${month} THEN queries_used+${cost} ELSE ${cost} END,quota_month=${month} WHERE id=${cursorId}`;
    return true;
  });
}

export async function lookupStateBillLive(
  prisma: PrismaClient,
  designation: { state: string; billNumber: string },
  deps: StateBillLiveDeps = {},
): Promise<StateBillLiveOutcome> {
  const apiKey = deps.apiKey ?? process.env.LEGISCAN_API_KEY;
  if (!apiKey) return { kind: 'unavailable', reason: 'not_configured' };
  const state = designation.state.toUpperCase();
  const wanted = billNumberKey(designation.billNumber);
  const now = (deps.now ?? (() => new Date()))();
  const missKey = `${state}:${wanted}`;
  const missedAt = recentMisses.get(missKey);
  if (missedAt !== undefined && now.getTime() - missedAt < MISS_TTL_MS) return { kind: 'not_found' };

  const softBudget = Math.min(
    LEGISCAN_HARD_CAP,
    deps.softBudget ?? Number(process.env.LEGISCAN_MONTHLY_BUDGET ?? 28_000),
  );
  const liveBudget =
    deps.liveMonthlyBudget ??
    Number(process.env.LEGISCAN_LIVE_LOOKUP_MONTHLY_BUDGET ?? DEFAULT_LIVE_MONTHLY_BUDGET);
  if (!Number.isFinite(softBudget) || !Number.isFinite(liveBudget))
    return { kind: 'unavailable', reason: 'quota' };
  if (!(await reserveLiveQuota(prisma, state, now, liveBudget, softBudget)))
    return { kind: 'unavailable', reason: 'quota' };

  const listSessions = deps.getSessionList ?? getSessionList;
  const listBills = deps.getMasterListRaw ?? getMasterListRaw;
  const readBill = deps.getBill ?? getBill;
  const persist =
    deps.persist ??
    (async (raw: LegiscanBill, rawState: string) => {
      const normalized = normalizeLegiscanBill(raw, rawState);
      if (!normalized) return null;
      await upsertNormalizedStateBill(prisma, normalized);
      return normalized.billKey;
    });
  try {
    const sessions = currentLegiscanSessions(
      await listSessions(apiKey, state, INTERACTIVE_LEGISCAN_TRANSPORT),
    );
    for (const session of sessions) {
      const bills = await listBills(apiKey, session.session_id, INTERACTIVE_LEGISCAN_TRANSPORT);
      const match = bills.find((bill) => billNumberKey(bill.number) === wanted);
      if (!match) continue;
      const raw = await readBill(apiKey, match.bill_id, undefined, INTERACTIVE_LEGISCAN_TRANSPORT);
      const billKey = raw ? await persist(raw, state) : null;
      if (!billKey) return { kind: 'unavailable', reason: 'provider_error' };
      recentMisses.delete(missKey);
      return { kind: 'found', billKey };
    }
  } catch {
    return { kind: 'unavailable', reason: 'provider_error' };
  }
  recentMisses.set(missKey, now.getTime());
  return { kind: 'not_found' };
}

/** Test seam: forget remembered misses. */
export function resetStateBillLiveMisses(): void {
  recentMisses.clear();
}
