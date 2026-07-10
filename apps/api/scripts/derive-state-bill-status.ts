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
 * this to LEGISCAN_STATES).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/derive-state-bill-status.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { deriveStateBillStatus, classifyStateVoteMotion } from '@capiro/shared';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();

// Fallback ONLY — the coded facts (legiscanStatus 5, progress event 7) are
// the primary vetoed/overridden signals; these regexes catch the rare case
// where a state's LegiScan feed doesn't carry the coded fact cleanly.
const VETOED_TEXT = /vetoed by the governor|governor'?s? veto/i;
const OVERRIDDEN_TEXT = /veto overridden|override(d)? the (governor'?s )?veto/i;

async function main() {
  await runWithSyncRun(prisma as never, 'derive-state-bill-status', async () => {
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    // 1. Passage/veto sets from state_roll_call_vote — a real passage-type
    // motion's outcome, keyed by bill.
    const votes = await prisma.stateRollCallVote.findMany({
      where: { passed: { not: null }, billKey: { not: null } },
      select: { billKey: true, motion: true, passed: true },
    });
    const passedChamber = new Set<string>();
    const failedChamber = new Set<string>();
    for (const v of votes) {
      if (!v.billKey || !classifyStateVoteMotion(v.motion)) continue;
      if (v.passed) passedChamber.add(v.billKey);
      else failedChamber.add(v.billKey);
    }

    // 2. Session sine-die map, keyed by (state, sessionKey) — the DD1 join.
    const sessions = await prisma.stateSession.findMany({
      where: { sineDie: { not: null } },
      select: { state: true, sessionKey: true, sineDie: true },
    });
    const sineDieByKey = new Map<string, string>();
    for (const s of sessions) {
      if (s.sineDie) {
        sineDieByKey.set(`${s.state}-${s.sessionKey}`, s.sineDie.toISOString().slice(0, 10));
      }
    }

    // 3. Recompute every bill; write ONLY when the status actually changes
    // (unlike the federal verb's unconditional rewrite — 100k+ state rows
    // make no-op writes worth skipping; deviation noted in the Phase 0 plan).
    const today = new Date().toISOString().slice(0, 10);
    const bills = await prisma.stateBill.findMany({
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
          sessionSineDie: sineDieByKey.get(`${b.state}-${b.sessionKey}`) ?? null,
          today,
        });
        if (res.status === b.status) {
          skipped++;
          continue;
        }
        await prisma.stateBill.update({
          where: { id: b.id },
          data: {
            status: res.status,
            statusAt: b.latestActionDate ?? b.textDate ?? new Date(),
            statusSource: 'derived',
          },
        });
        updated++;
      } catch (err) {
        errors++;
        console.error(`[derive-state-bill-status] ${b.id} failed:`, err);
      }
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
