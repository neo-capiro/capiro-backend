/**
 * Deadline Physics + Chokepoint backtest (Phase 1 M2-E/M2-H). GLOBAL read-only
 * report over COMPLETED sessions (sine_die already passed) — no writes.
 *
 * M2-E (dead_by_deadline derivation): cross-checks the coded `status` column
 * against an independent text signal — a bill whose `latest_action_text`
 * reads like an enactment ("signed", "chaptered", "became law", "enacted")
 * but whose canonical status is NOT `enacted` is flagged as a possible
 * misclassification. This is a DATA-QUALITY check (two independent signals
 * cross-checked), not a true external-ground-truth accuracy backtest — no
 * "actually happened" oracle exists outside this same database.
 *
 * M2-H (survival heuristic): for each completed session's bills, computes
 * ChokepointService.forBill(...).survivalBand using CURRENT (near-final)
 * data and reports the outcome split per band (enacted/passed vs dead/
 * failed). KNOWN LIMITATION, stated plainly rather than overclaimed: because
 * the session has already ended, "current" bill state IS near-final —
 * this measures whether the heuristic's WEIGHTS are directionally sound
 * against final outcomes, not genuine early-warning predictive accuracy
 * (which would need a point-in-time status snapshot this schema doesn't
 * keep). Useful for the weight-calibration pass the plan calls for; not a
 * substitute for a true prospective backtest once historical snapshots
 * exist.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/backtest-deadline-physics.ts
 * Env: BACKTEST_STATES (comma-separated 2-letter codes; default = all with a
 *      completed session), BACKTEST_SAMPLE_CAP (per-session bill cap for the
 *      survival-heuristic pass, default 200 — keeps this a fast report, not
 *      a full-corpus job).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { stateBillStatusRank } from '@capiro/shared';
import { ChokepointService } from '../src/intelligence/chokepoint/chokepoint.service.js';
import { RepresentationResolverService } from '../src/clients/representation-resolver.service.js';
dotenvConfig();

const prisma = new PrismaClient();
const STATES = (process.env.BACKTEST_STATES ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const SAMPLE_CAP = Number(process.env.BACKTEST_SAMPLE_CAP ?? '200');
const ENACTMENT_TEXT = /(signed|chaptered|became law|enacted|approved by the governor)/i;

const ENACTED_LIKE = new Set(['enacted', 'veto_overridden']);
const DEAD_LIKE = new Set(['vetoed', 'failed', 'dead_by_deadline']);

async function main() {
  const sessions = await prisma.stateSession.findMany({
    where: { sineDie: { lt: new Date() }, ...(STATES.length ? { state: { in: STATES } } : {}) },
    select: { state: true, sessionKey: true, sineDie: true },
  });
  console.log(`[backtest-deadline-physics] ${sessions.length} completed session(s) in scope`);

  // ── M2-E: coded-status vs text-signal cross-check ────────────────────────
  let e_checked = 0;
  let e_flagged = 0;
  for (const s of sessions) {
    const bills = await prisma.stateBill.findMany({
      where: { state: s.state, sessionKey: s.sessionKey },
      select: { id: true, status: true, latestActionText: true },
    });
    for (const b of bills) {
      e_checked++;
      if (b.status !== 'enacted' && ENACTMENT_TEXT.test(b.latestActionText ?? '')) {
        e_flagged++;
        console.log(
          `[backtest-deadline-physics] M2-E flag: ${b.id} status="${b.status}" but latestActionText="${b.latestActionText}"`,
        );
      }
    }
  }
  const e_flagRate = e_checked ? (e_flagged / e_checked) * 100 : 0;
  console.log(
    `[backtest-deadline-physics] M2-E: ${e_checked} bills checked, ${e_flagged} flagged (${e_flagRate.toFixed(2)}%) — target: this stays near 0%, since any flag is a real coded-vs-text disagreement worth a human look`,
  );

  // ── M2-H: survival-band vs final outcome (documented limitation above) ──
  const representation = new RepresentationResolverService(prisma as never);
  const chokepoint = new ChokepointService(prisma as never, representation);
  const byBand: Record<string, { enactedLike: number; deadLike: number; other: number }> = {
    stalled: { enactedLike: 0, deadLike: 0, other: 0 },
    'at-risk': { enactedLike: 0, deadLike: 0, other: 0 },
    'likely-advances': { enactedLike: 0, deadLike: 0, other: 0 },
  };
  let h_scored = 0;
  let h_errors = 0;
  for (const s of sessions) {
    const bills = await prisma.stateBill.findMany({
      where: { state: s.state, sessionKey: s.sessionKey, status: { not: null } },
      select: { id: true, status: true },
      take: SAMPLE_CAP,
    });
    for (const b of bills) {
      // A bill still 'introduced'/'committee' with no further movement at
      // session end has no real chokepoint story to score (never reported,
      // never crossed over) — skip rather than force a heuristic on a bill
      // that simply never got a hearing.
      if (stateBillStatusRank(b.status) < 1) continue;
      try {
        const result = await chokepoint.forBill(b.id);
        if (!result.survivalBand) continue;
        h_scored++;
        const bucket = byBand[result.survivalBand];
        if (ENACTED_LIKE.has(b.status ?? '')) bucket.enactedLike++;
        else if (DEAD_LIKE.has(b.status ?? '')) bucket.deadLike++;
        else bucket.other++;
      } catch (err) {
        h_errors++;
        console.error(
          `[backtest-deadline-physics] chokepoint failed for ${b.id}:`,
          (err as Error).message,
        );
      }
    }
  }
  console.log(`[backtest-deadline-physics] M2-H: ${h_scored} bill(s) scored, ${h_errors} error(s)`);
  for (const [band, counts] of Object.entries(byBand)) {
    const total = counts.enactedLike + counts.deadLike + counts.other;
    if (!total) continue;
    const enactedPct = ((counts.enactedLike / total) * 100).toFixed(1);
    const deadPct = ((counts.deadLike / total) * 100).toFixed(1);
    console.log(
      `[backtest-deadline-physics] band=${band} n=${total} enacted-like=${enactedPct}% dead-like=${deadPct}% other=${counts.other}`,
    );
  }
  console.log(
    '[backtest-deadline-physics] M2-H target (v1, to calibrate): of "stalled", >=70% dead-like; of "likely-advances", >=70% enacted-like. See doc comment for the near-final-data limitation before trusting these numbers as predictive accuracy.',
  );
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
