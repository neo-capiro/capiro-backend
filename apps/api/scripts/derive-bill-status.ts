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

export interface StatusActionEvidence {
  date: Date;
  text: string;
}

export interface PassageVoteEvidence {
  id: string;
  billId: string | null;
  result: string | null;
  question: string | null;
  voteDate: Date;
  rollNumber: number;
}

export interface LatestPassageOutcome {
  outcome: 'pass' | 'fail';
  date: Date;
  rollNumber: number;
  voteId: string;
}

/**
 * Keep exactly one current passage verdict per bill. An earlier chamber pass
 * must not mask a later failed final-passage vote (and a later successful
 * reconsideration must likewise supersede an earlier failure).
 */
export function latestPassageOutcomes(
  votes: PassageVoteEvidence[],
): Map<string, LatestPassageOutcome> {
  const latestByBill = new Map<string, LatestPassageOutcome>();
  for (const vote of votes) {
    if (!vote.billId || !isPassageQuestion(vote.question)) continue;
    const outcome = classifyVoteResult(vote.result);
    if (!outcome) continue;
    const candidate: LatestPassageOutcome = {
      outcome,
      date: vote.voteDate,
      rollNumber: vote.rollNumber,
      voteId: vote.id,
    };
    const prior = latestByBill.get(vote.billId);
    const isNewer =
      !prior ||
      candidate.date.getTime() > prior.date.getTime() ||
      (candidate.date.getTime() === prior.date.getTime() &&
        (candidate.rollNumber > prior.rollNumber ||
          (candidate.rollNumber === prior.rollNumber && candidate.voteId > prior.voteId)));
    if (isNewer) latestByBill.set(vote.billId, candidate);
  }
  return latestByBill;
}

/**
 * The canonical status timestamp is the event that established the status, not
 * simply the newest action on the bill. A later receipt/referral therefore does
 * not move a House-passage date forward.
 */
export function statusEventDate(input: {
  status: string;
  latestActionDate: Date | null;
  updateDate: Date | null;
  passageVoteDate: Date | null;
  actions: StatusActionEvidence[];
  fallbackNow?: Date;
}): Date {
  if (input.status === 'passed_chamber') {
    if (input.passageVoteDate) return input.passageVoteDate;
    const passageAction = input.actions
      .filter((action) => isPassageActionText(action.text))
      .sort((a, b) => b.date.getTime() - a.date.getTime())[0];
    if (passageAction) return passageAction.date;
  }
  return input.latestActionDate ?? input.updateDate ?? input.fallbackNow ?? new Date();
}

function isPassageActionText(text: string): boolean {
  const t = text.toLowerCase();
  if (/motion to (recommit|reconsider|table)|cloture|previous question/.test(t)) return false;
  return /\bon passage\b.*\b(pass|agree)|passed\/agreed to in (the )?(house|senate)|\bpassed (the )?(house|senate)\b|passage of the bill|third reading.*\b(pass|agree)/.test(
    t,
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
      select: {
        id: true,
        billId: true,
        result: true,
        question: true,
        voteDate: true,
        rollNumber: true,
      },
    });
    const passedChamber = new Set<string>();
    const passedChamberAt = new Map<string, Date>();
    const failedChamber = new Set<string>();
    for (const [billId, verdict] of latestPassageOutcomes(passageVotes)) {
      if (verdict.outcome === 'pass') {
        passedChamber.add(billId);
        passedChamberAt.set(billId, verdict.date);
      } else {
        failedChamber.add(billId);
      }
    }

    // 3. Recompute status for every bill in scope.
    const bills = await prisma.congressBill.findMany({
      where: { congress: { in: CONGRESSES } },
      select: {
        id: true,
        latestActionText: true,
        latestActionDate: true,
        updateDate: true,
        actions: { select: { text: true, date: true } },
      },
    });
    for (const b of bills) {
      try {
        const res = deriveBillStatus({
          latestActionText: b.latestActionText,
          actionTexts: b.actions.map((action) => action.text),
          ruleOutcome: targetOutcome.get(b.id) ?? null,
          passedChamber: passedChamber.has(b.id),
          failedChamber: failedChamber.has(b.id),
        });
        await prisma.congressBill.update({
          where: { id: b.id },
          data: {
            status: res.status,
            statusAt: statusEventDate({
              status: res.status,
              latestActionDate: b.latestActionDate,
              updateDate: b.updateDate,
              passageVoteDate: passedChamberAt.get(b.id) ?? null,
              actions: b.actions,
            }),
          },
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
