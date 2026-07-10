/**
 * Derive + persist the canonical state_bill.status (State Legislation
 * Platform Phase 0 S3). Second consumer of derive-bill-status.ts's pattern,
 * one abstraction up — state legislatures have no House-rule mechanic, so
 * this feeds three different signals into `deriveStateBillStatus`:
 *   - the bill's own legiscanStatus/legiscanProgress (LegiScan's coded facts,
 *     persisted verbatim at ingestion time — the derivation spine, DD8),
 *   - whether a real chamber-passage vote (state_roll_call_vote, classified
 *     via classifyStateVoteMotion) passed or failed THIS bill,
 *   - the bill's session sine_die date (state_session) for dead_by_deadline.
 * Text-regex (latestActionText, vetoed/overridden fallback) is used ONLY as a
 * fallback signal alongside the coded facts — never the primary source.
 *
 * Runs unconditionally over every state_bill (pure DB compute, no external
 * API cost — unlike the LegiScan sync verbs there is no quota reason to scope
 * this to LEGISCAN_STATES). The bill scan is cursor-paginated (BATCH_SIZE) so
 * peak memory stays bounded regardless of corpus size — a single unbounded
 * findMany() over 100k+ rows (each carrying a jsonb progress array and full
 * action text) would otherwise scale memory with the whole corpus.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/derive-state-bill-status.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { deriveStateBillStatus, classifyStateVoteMotion } from '@capiro/shared';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();

const BATCH_SIZE = 5000;

// Fallback ONLY — the coded facts (legiscanStatus 5, progress event 7) are
// the primary vetoed/overridden signals; these regexes catch the rare case
// where a state's LegiScan feed doesn't carry the coded fact cleanly.
const VETOED_TEXT = /vetoed by the governor|governor'?s? veto/i;
const OVERRIDDEN_TEXT = /veto overridden|override(d)? the (governor'?s )?veto/i;

export interface PassageVoteInput {
  billKey: string | null;
  motion: string | null;
  passed: boolean | null;
  date: Date;
  legiscanRollCallId: number;
}

/**
 * Build the (passedChamber, failedChamber) sets from every classified
 * passage-type roll-call vote, keyed by each bill's MOST RECENT such vote
 * (by date, then legiscanRollCallId as a deterministic tiebreak for
 * same-day votes) — never "any qualifying vote ever," which let a bill land
 * in BOTH sets when it failed a floor vote and was later reconsidered and
 * passed (the failed/passed inversion bug: a stale failed-vote signal
 * outranked the bill's actual current state). A bill therefore appears in
 * AT MOST ONE of the two returned sets, reflecting only its latest passage
 * verdict.
 */
export function buildPassageOutcomeSets(votes: PassageVoteInput[]): {
  passedChamber: Set<string>;
  failedChamber: Set<string>;
} {
  const latestByBill = new Map<
    string,
    { passed: boolean; date: Date; legiscanRollCallId: number }
  >();
  for (const v of votes) {
    if (!v.billKey || v.passed === null || !classifyStateVoteMotion(v.motion)) continue;
    const prev = latestByBill.get(v.billKey);
    const isNewer =
      !prev ||
      v.date.getTime() > prev.date.getTime() ||
      (v.date.getTime() === prev.date.getTime() && v.legiscanRollCallId > prev.legiscanRollCallId);
    if (isNewer) {
      latestByBill.set(v.billKey, {
        passed: v.passed,
        date: v.date,
        legiscanRollCallId: v.legiscanRollCallId,
      });
    }
  }
  const passedChamber = new Set<string>();
  const failedChamber = new Set<string>();
  for (const [billKey, outcome] of latestByBill) {
    if (outcome.passed) passedChamber.add(billKey);
    else failedChamber.add(billKey);
  }
  return { passedChamber, failedChamber };
}

/** DD1 join key for a bill's session (state_session is keyed the same way). */
export function sineDieKey(state: string, sessionKey: string): string {
  return `${state}-${sessionKey}`;
}

export interface StatusUpdateData {
  status: string;
  statusAt: Date;
  statusSource: 'derived';
  statusDerivedAt: Date;
}

/**
 * Build the update payload for a bill whose derived status changed. Pure and
 * exported so the statusDerivedAt stamp (2026-07-10 hot-fix, S5.3) is
 * directly testable without a DB. `now` is injectable for deterministic
 * tests; production calls always pass the real current time.
 */
export function buildStatusUpdateData(
  bill: { latestActionDate: Date | null; textDate: Date | null },
  status: string,
  now: Date = new Date(),
): StatusUpdateData {
  return {
    status,
    statusAt: bill.latestActionDate ?? bill.textDate ?? now,
    statusSource: 'derived',
    // Ingestion-time anchor, distinct from statusAt's legislative event
    // date, so emit-state-changes can window on when the change was
    // actually WRITTEN rather than the (often-midnight, often-stale-
    // relative-to-a-same-day-run) legislative date.
    statusDerivedAt: now,
  };
}

async function main() {
  await runWithSyncRun(prisma as never, 'derive-state-bill-status', async () => {
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    // 1. Passage/veto sets from state_roll_call_vote — each bill's MOST
    // RECENT real passage-type motion outcome (S3 hot-fix: mutual exclusivity).
    const votes = await prisma.stateRollCallVote.findMany({
      where: { passed: { not: null }, billKey: { not: null } },
      select: { billKey: true, motion: true, passed: true, date: true, legiscanRollCallId: true },
    });
    const { passedChamber, failedChamber } = buildPassageOutcomeSets(votes);

    // 2. Session sine-die map, keyed by (state, sessionKey) — the DD1 join.
    const sessions = await prisma.stateSession.findMany({
      where: { sineDie: { not: null } },
      select: { state: true, sessionKey: true, sineDie: true },
    });
    const sineDieByKey = new Map<string, string>();
    for (const s of sessions) {
      if (s.sineDie) {
        sineDieByKey.set(sineDieKey(s.state, s.sessionKey), s.sineDie.toISOString().slice(0, 10));
      }
    }

    // 3. Recompute every bill in bounded batches; write ONLY when the status
    // actually changes (unlike the federal verb's unconditional rewrite —
    // 100k+ state rows make no-op writes worth skipping; deviation noted in
    // the Phase 0 plan).
    const today = new Date().toISOString().slice(0, 10);
    let lastId: string | undefined;
    for (;;) {
      const bills = await prisma.stateBill.findMany({
        take: BATCH_SIZE,
        ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          state: true,
          sessionKey: true,
          status: true,
          legiscanStatus: true,
          legiscanProgress: true,
          latestActionText: true,
          latestActionDate: true,
          textDate: true,
        },
      });
      if (bills.length === 0) break;

      for (const b of bills) {
        try {
          const progressEvents = Array.isArray(b.legiscanProgress)
            ? (b.legiscanProgress as unknown as Array<{ event: number; date: string }>)
            : [];
          const text = b.latestActionText ?? '';
          const res = deriveStateBillStatus({
            legiscanStatus: b.legiscanStatus,
            progressEvents,
            latestActionText: text,
            passedChamber: passedChamber.has(b.id),
            failedChamber: failedChamber.has(b.id),
            vetoed: VETOED_TEXT.test(text),
            overridden: OVERRIDDEN_TEXT.test(text),
            sessionSineDie: sineDieByKey.get(sineDieKey(b.state, b.sessionKey)) ?? null,
            today,
          });
          if (res.status === b.status) {
            skipped++;
            continue;
          }
          await prisma.stateBill.update({
            where: { id: b.id },
            data: buildStatusUpdateData(b, res.status),
          });
          updated++;
        } catch (err) {
          errors++;
          console.error(`[derive-state-bill-status] ${b.id} failed:`, err);
        }
      }
      lastId = bills[bills.length - 1]!.id;
    }
    console.log(
      `[derive-state-bill-status] ${updated} updated, ${skipped} unchanged, ${passedChamber.size} passed-chamber sets, ${failedChamber.size} failed-chamber sets, ${errors} errors`,
    );
    return { inserted: 0, updated, skipped, errors };
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
