/**
 * Derive + persist the canonical congress_bill.status (LegiWatch A4).
 *
 * Runs AFTER sync-congress + the vote syncs (it reads roll_call_vote and
 * bill_rule_link). For each bill it resolves the honest legislative status via
 * @capiro/shared deriveBillStatus, feeding it three signals:
 *   - the bill's own latestActionText,
 *   - whether a roll-call vote on THIS bill passed a chamber,
 *   - the outcome of the bill's GOVERNING rule (bill_rule_link -> the rule's
 *     own vote / action text) — the H.R. 8800 fix: a bill whose latest action
 *     is only "Rule reported" but whose rule FAILED is rule_failed, not
 *     advancing.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/derive-bill-status.ts
 * Env: BILL_STATUS_CONGRESSES (default "117,118,119").
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { deriveBillStatus, classifyVoteResult } from '@capiro/shared';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();
const CONGRESSES = (process.env.BILL_STATUS_CONGRESSES ?? '117,118,119')
  .split(',')
  .map((c) => parseInt(c.trim(), 10))
  .filter((c) => Number.isInteger(c) && c > 0);

/**
 * Passage-question heuristic — distinguishes a FINAL-passage vote from a
 * procedural one. Must cover the House's most common passage mechanism,
 * "On Motion to Suspend the Rules and Pass" (which contains "pass" but NOT
 * "passage"), plus resolution passage ("On Agreeing to the Resolution") and
 * the ordinary "On Passage" / "Third Reading" / concurrence forms. Kept out:
 * motions to recommit/table/reconsider, cloture, and rule-adoption of OTHER
 * measures (those never carry this bill's own billId anyway).
 */
export function isPassageQuestion(question: string | null | undefined): boolean {
  const q = (question ?? '').toLowerCase();
  return /on passage|passage of the bill|suspend the rules and pass|suspend the rules and agree|third reading|to concur|concur in the senate amendment|on agreeing to the resolution|on agreeing to the (conference|senate|house) amendment/.test(
    q,
  );
}

async function main() {
  await runWithSyncRun(prisma as never, 'derive-bill-status', async () => {
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    // 1. Rule outcomes: for each rule hres that governs some bill, classify
    // adopted/failed from its own roll-call vote (primary) or action text.
    const links = await prisma.billRuleLink.findMany({
      select: { ruleBillId: true, targetBillId: true },
    });
    const ruleIds = [...new Set(links.map((l) => l.ruleBillId))];
    const ruleOutcome = new Map<string, 'adopted' | 'failed'>();
    for (const ruleId of ruleIds) {
      const votes = await prisma.rollCallVote.findMany({
        where: { billId: ruleId },
        orderBy: { voteDate: 'desc' },
        select: { result: true },
      });
      let decided: 'adopted' | 'failed' | null = null;
      for (const v of votes) {
        const c = classifyVoteResult(v.result);
        if (c === 'pass') {
          decided = 'adopted';
          break;
        }
        if (c === 'fail') {
          decided = 'failed';
          break;
        }
      }
      if (!decided) {
        const ruleBill = await prisma.congressBill.findUnique({
          where: { id: ruleId },
          select: { latestActionText: true },
        });
        const c = classifyVoteResult(ruleBill?.latestActionText);
        if (c === 'pass') decided = 'adopted';
        else if (c === 'fail') decided = 'failed';
      }
      if (decided) ruleOutcome.set(ruleId, decided);
    }

    // target bill -> governing rule outcome (an adopted rule supersedes a failed one).
    const targetOutcome = new Map<string, 'adopted' | 'failed'>();
    for (const l of links) {
      const o = ruleOutcome.get(l.ruleBillId);
      if (!o) continue;
      const cur = targetOutcome.get(l.targetBillId);
      if (o === 'adopted' || !cur) targetOutcome.set(l.targetBillId, o);
    }

    // 2. Bills with a chamber PASSAGE or FAILED-passage roll-call vote of their
    // own. failedChamber catches a measure that lost a floor vote while its
    // latest action text is procedural (e.g. a rule hres whose vote failed).
    const passageVotes = await prisma.rollCallVote.findMany({
      where: { result: { not: null } },
      select: { billId: true, result: true, question: true },
    });
    const passedChamber = new Set<string>();
    const failedChamber = new Set<string>();
    for (const v of passageVotes) {
      if (!v.billId || !isPassageQuestion(v.question)) continue;
      const c = classifyVoteResult(v.result);
      if (c === 'pass') passedChamber.add(v.billId);
      else if (c === 'fail') failedChamber.add(v.billId);
    }

    // 3. Recompute status for every bill in scope.
    const bills = await prisma.congressBill.findMany({
      where: { congress: { in: CONGRESSES } },
      select: { id: true, latestActionText: true, latestActionDate: true, updateDate: true },
    });
    for (const b of bills) {
      try {
        const res = deriveBillStatus({
          latestActionText: b.latestActionText,
          ruleOutcome: targetOutcome.get(b.id) ?? null,
          passedChamber: passedChamber.has(b.id),
          failedChamber: failedChamber.has(b.id),
        });
        await prisma.congressBill.update({
          where: { id: b.id },
          data: { status: res.status, statusAt: b.latestActionDate ?? b.updateDate ?? new Date() },
        });
        updated++;
      } catch (err) {
        errors++;
        console.error(`[derive-bill-status] ${b.id} failed:`, err);
      }
    }
    console.log(
      `[derive-bill-status] ${updated} bills, ${targetOutcome.size} rule-governed, ${passedChamber.size} passed-chamber`,
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
