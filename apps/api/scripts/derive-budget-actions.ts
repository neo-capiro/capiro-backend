/**
 * derive-budget-actions (BL-0): normalizes program_element_year committee marks
 * into budget_action rows (§1.2) — one event per (line, fy, stage, action).
 *
 * Deterministic rules, all evidence-carrying:
 *  - add / cut per stage: mark differs from the same-FY request beyond the
 *    posture tolerance (0.5% / $0.5M floor — same thresholds as the
 *    committee-posture engine so a chip and a feed row never disagree).
 *    Stages: HASC, SASC, HAC_D, SAC_D, CONF (vs request), ENACTED (vs request).
 *  - new_start: the line's earliest FY with any stated value equals the
 *    dataset's current cycle FY — i.e. it first appeared in the open cycle.
 *  - termination: the line had funding in a prior FY but has NO stated value
 *    in the current cycle FY (mirrors the profile's "historical-only" logic).
 *
 * hold / transfer / rescission are RESERVED: they need report-language /
 * reprogramming ingests that don't exist yet. This verb never fabricates them.
 *
 * Idempotent + regenerable: with --commit it deletes its own derivedBy cohort
 * and rewrites; without --commit it prints counts + samples only.
 *
 *   derive-budget-actions [--commit]
 *
 * Phase 7 Workstream M/N containment: this is one of the twelve legacy
 * dispatcher verbs gated behind `PE_LEGACY_BUDGET_WRITES` (see
 * `legacy-budget-write-gate-v1.ts`), but the gate as shipped in session 6 was
 * enforced only in the shell dispatcher (`entrypoint-dispatcher.inc`) — and
 * `run-pe-derive-chain.ts` spawns this script's `--commit` invocation
 * directly, bypassing that dispatcher entirely. The check below closes that
 * specific bypass by making the gate a property of this script, not just of
 * one caller of it.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  legacyBudgetCommitDecisionV1,
  legacyBudgetWriteModeFromEnvV1,
} from '../src/defense-budget/promotion/legacy-budget-write-gate-v1.js';

dotenvConfig();

const DERIVED_BY = 'derive-budget-actions@v1';
const TOLERANCE_FRACTION = 0.005;
const TOLERANCE_FLOOR_M = 0.5;

interface ActionRow {
  peCode: string;
  fy: number;
  stage: string;
  action: string;
  amount: number | null;
  baseline: string;
  note: string;
  evidenceJson: Record<string, unknown>;
}

const n = (v: Prisma.Decimal | null): number | null => (v === null ? null : Number(v));

function fmtM(v: number): string {
  const a = Math.abs(v);
  return a >= 1000 ? `$${(a / 1000).toFixed(2)}B` : `$${a.toFixed(1)}M`;
}

function markActions(
  peCode: string,
  fy: number,
  request: number,
  stages: Array<[string, string, number | null]>,
): ActionRow[] {
  const out: ActionRow[] = [];
  const tol = Math.max(request * TOLERANCE_FRACTION, TOLERANCE_FLOOR_M);
  for (const [stage, label, mark] of stages) {
    if (mark === null) continue;
    const delta = mark - request;
    if (Math.abs(delta) <= tol) continue;
    out.push({
      peCode,
      fy,
      stage,
      action: delta > 0 ? 'add' : 'cut',
      amount: Math.round(delta * 100) / 100,
      baseline: 'request',
      note: `${label} ${delta > 0 ? '+' : '−'}${fmtM(delta)} ${delta > 0 ? 'over' : 'under'} the FY${fy} request`,
      evidenceJson: { request, mark, delta, sourceField: stage.toLowerCase() },
    });
  }
  return out;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');

  // Same policy the shell dispatcher enforces for a direct `derive-budget-actions
  // --commit` invocation, applied here too so a caller that spawns this script
  // directly (run-pe-derive-chain.ts) cannot skip it. readMode is intentionally
  // omitted — matching the shell dispatcher's own check today, which is
  // PE_LEGACY_BUDGET_WRITES-only and does not yet look at the read mode either;
  // extending both to also veto on an active snapshot/canary read is a follow-on,
  // not something to introduce as a side effect of closing this bypass.
  const decision = legacyBudgetCommitDecisionV1({
    verb: 'derive-budget-actions',
    argv: process.argv,
    writeMode: legacyBudgetWriteModeFromEnvV1(process.env.PE_LEGACY_BUDGET_WRITES),
  });
  if (!decision.allowed) {
    console.error(decision.message);
    process.exit(64);
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const years = await prisma.programElementYear.findMany({
      select: {
        peCode: true,
        fy: true,
        request: true,
        hascMark: true,
        sascMark: true,
        hacDMark: true,
        sacDMark: true,
        conference: true,
        ndaaConference: true,
        enacted: true,
      },
    });
    const retired = new Set(
      (
        await prisma.programElement.findMany({
          where: { retiredAt: { not: null } },
          select: { peCode: true },
        })
      ).map((p) => p.peCode),
    );

    // Current cycle = the FY with the MOST lines carrying a live request (the
    // mode) — the same convention as the profile's currentCycleFy. NOT max():
    // a handful of lines carry FYDP outyear rows (e.g. FY2031 requests), and
    // max() would declare FY2031 the open cycle and mis-flag nearly every
    // real line as a termination. Caught on the first prod dry run.
    const requestCountByFy = new Map<number, number>();
    for (const y of years) {
      if (y.request !== null) requestCountByFy.set(y.fy, (requestCountByFy.get(y.fy) ?? 0) + 1);
    }
    let currentCycleFy = 0;
    let bestCount = 0;
    for (const [fy, count] of requestCountByFy) {
      // Ties break toward the LATER fy (a new cycle overtaking the old one).
      if (count > bestCount || (count === bestCount && fy > currentCycleFy)) {
        currentCycleFy = fy;
        bestCount = count;
      }
    }

    const byPe = new Map<string, typeof years>();
    for (const y of years) {
      if (retired.has(y.peCode)) continue;
      const list = byPe.get(y.peCode);
      if (list) list.push(y);
      else byPe.set(y.peCode, [y]);
    }

    const rows: ActionRow[] = [];
    for (const [peCode, peYears] of byPe) {
      peYears.sort((a, b) => a.fy - b.fy);
      const hasValue = (y: (typeof peYears)[number]) =>
        [
          y.request,
          y.hascMark,
          y.sascMark,
          y.hacDMark,
          y.sacDMark,
          y.ndaaConference,
          y.conference,
          y.enacted,
        ].some((v) => v !== null && Number(v) !== 0);
      const valuedYears = peYears.filter(hasValue);
      if (valuedYears.length === 0) continue;

      // Per-stage add/cut events.
      for (const y of peYears) {
        const request = n(y.request);
        if (request === null || request === 0) continue;
        rows.push(
          ...markActions(peCode, y.fy, request, [
            ['HASC', 'HASC', n(y.hascMark)],
            ['SASC', 'SASC', n(y.sascMark)],
            ['HAC_D', 'HAC-D', n(y.hacDMark)],
            ['SAC_D', 'SAC-D', n(y.sacDMark)],
            // The conference budget action is the NDAA (authorization) conference — the
            // only conference value populated today; it now lives in ndaaConference.
            ['CONF', 'Conference', n(y.ndaaConference)],
            ['ENACTED', 'Enacted', n(y.enacted)],
          ]),
        );
      }

      // new_start: first valued FY IS the current cycle.
      const firstFy = valuedYears[0]!.fy;
      if (firstFy === currentCycleFy) {
        const req = n(valuedYears[0]!.request);
        rows.push({
          peCode,
          fy: firstFy,
          stage: 'PB',
          action: 'new_start',
          amount: req,
          baseline: 'prior_year',
          note: `New start — first appears in the FY${firstFy} cycle${req !== null ? ` at ${fmtM(req)}` : ''}`,
          evidenceJson: { firstFy, request: req },
        });
      }

      // termination: funded before, absent from the current cycle.
      const lastValued = valuedYears[valuedYears.length - 1]!;
      if (lastValued.fy < currentCycleFy) {
        const lastAmount =
          n(lastValued.enacted) ??
          n(lastValued.ndaaConference) ??
          n(lastValued.conference) ??
          n(lastValued.request);
        rows.push({
          peCode,
          fy: currentCycleFy,
          stage: 'PB',
          action: 'termination',
          amount: lastAmount === null ? null : -lastAmount,
          baseline: 'prior_year',
          note: `No FY${currentCycleFy} entry — last valued year FY${lastValued.fy}${lastAmount !== null ? ` at ${fmtM(lastAmount)}` : ''}`,
          evidenceJson: { lastValuedFy: lastValued.fy, lastAmount, currentCycleFy },
        });
      }
    }

    const byAction = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.action] = (acc[r.action] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      JSON.stringify(
        {
          verb: DERIVED_BY,
          commit,
          currentCycleFy,
          linesExamined: byPe.size,
          actions: rows.length,
          byAction,
          samples: rows
            .slice(0, 5)
            .map((r) => `${r.peCode} FY${r.fy} ${r.stage} ${r.action}: ${r.note}`),
        },
        null,
        2,
      ),
    );

    if (!commit) {
      console.log('DRY RUN — re-run with --commit to write.');
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.budgetAction.deleteMany({ where: { derivedBy: DERIVED_BY } });
        // createMany in chunks (Prisma param limits).
        for (let i = 0; i < rows.length; i += 1000) {
          await tx.budgetAction.createMany({
            data: rows.slice(i, i + 1000).map((r) => ({
              peCode: r.peCode,
              fy: r.fy,
              stage: r.stage,
              action: r.action,
              amount: r.amount,
              baseline: r.baseline,
              note: r.note,
              evidenceJson: r.evidenceJson as Prisma.InputJsonValue,
              derivedBy: DERIVED_BY,
            })),
            skipDuplicates: true,
          });
        }
        // Prisma's default interactive-transaction timeout is 5s — far too short
        // for tens of createMany batches against Aurora. Explicit ceiling.
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
    console.log(JSON.stringify({ written: rows.length }));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
