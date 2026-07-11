/**
 * Outreach judge calibration harness (Wave 1.3).
 *   pnpm --filter @capiro/api eval:outreach:calibrate -- --mode=emit  --report=<eval-report.json>
 *   pnpm --filter @capiro/api eval:outreach:calibrate -- --mode=score --ranking=<ninja-ranking.json>
 *
 * WHY: the LLM judge in eval-outreach.ts scores drafts 1-5 per dimension, but a
 * judge is only trustworthy once its ordering agrees with a human's. The plan's
 * W1.3 gate is Spearman >= 0.7 between the judge's average scores and Ninja's
 * manual ranking of ~20 drafts. This is a HARD human dependency — no agent can
 * substitute Ninja's taste. This harness makes the ranking session drop-in:
 *
 *   1. `emit` reads an existing eval report (from `pnpm eval:outreach`, which
 *      already generated + judged every fixture×model draft — no NEW tokens
 *      spent) and writes:
 *        - outreach-calibration-<ts>.md   a BLIND, numbered sheet of the drafts
 *          (subject+body only, judge scores hidden) for Ninja to rank best→worst.
 *        - outreach-calibration-scores.json   {id -> judgeAvg} the judge assigned.
 *   2. Ninja ranks the sheet into a ranking file: JSON `{ "<id>": <rank1based>, ... }`
 *      (rank 1 = best). Fill it in and hand it back.
 *   3. `score` computes Spearman rank correlation between Ninja's ranking and the
 *      judge's score ordering, and writes outreach-calibration-report-<ts>.json.
 *      >= 0.7 → the judge is calibrated (W1.3 met). Below → iterate the judge
 *      rubric wording (fixtures.ts `judge` arrays) and re-run the eval + this.
 *
 * Pure file I/O + arithmetic (no API calls), so `score` is unit-testable and the
 * whole flow is deterministic given the inputs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// NB: uses __dirname/__filename (not import.meta) so this module stays compilable
// under ts-jest's CommonJS target for its .spec — tsx shims both for the CLI run.

interface DraftRow {
  id: string; // `${fixtureId}::${model}`
  subject: string;
  body: string;
  judgeAvg: number;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function reportsDir(): string {
  return join(__dirname, '..', 'reports');
}

/** Flatten an eval report's fixtures×models into ranked draft rows. */
export function extractDraftRows(report: {
  fixtures?: Record<string, Record<string, unknown>>;
}): DraftRow[] {
  const rows: DraftRow[] = [];
  for (const [fid, byModel] of Object.entries(report.fixtures ?? {})) {
    for (const [model, r] of Object.entries(byModel)) {
      const rec = r as {
        judge?: { scores?: Record<string, number> };
        draft?: { subject?: string; body?: string };
      };
      const dims = Object.values(rec.judge?.scores ?? {});
      const judgeAvg = dims.length ? dims.reduce((a, b) => a + b, 0) / dims.length : 0;
      rows.push({
        id: `${fid}::${model}`,
        subject: rec.draft?.subject ?? '',
        body: rec.draft?.body ?? '',
        judgeAvg,
      });
    }
  }
  return rows;
}

/**
 * Spearman's rank correlation between two orderings over the same ids. Ranks are
 * assigned by value (ties get their average rank). Returns a number in [-1, 1].
 */
export function spearman(a: Record<string, number>, b: Record<string, number>): number {
  const ids = Object.keys(a).filter((id) => id in b);
  const n = ids.length;
  if (n < 2) return NaN;
  const rank = (vals: Record<string, number>): Record<string, number> => {
    const sorted = [...ids].sort((x, y) => vals[x]! - vals[y]!);
    const ranks: Record<string, number> = {};
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && vals[sorted[j + 1]!]! === vals[sorted[i]!]!) j++;
      const avgRank = (i + j) / 2 + 1; // 1-based, averaged over the tie group
      for (let k = i; k <= j; k++) ranks[sorted[k]!] = avgRank;
      i = j + 1;
    }
    return ranks;
  };
  const ra = rank(a);
  const rb = rank(b);
  let d2 = 0;
  for (const id of ids) {
    const d = ra[id]! - rb[id]!;
    d2 += d * d;
  }
  return 1 - (6 * d2) / (n * (n * n - 1));
}

function emit(reportPath: string): void {
  const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
    fixtures?: Record<string, Record<string, unknown>>;
  };
  const rows = extractDraftRows(report);
  // Higher judgeAvg = better; Ninja ranks best→worst independently, so present
  // the drafts in a STABLE, judge-agnostic order (by id) — never sorted by score,
  // which would bias the human ranker.
  rows.sort((x, y) => x.id.localeCompare(y.id));
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const mdLines: string[] = [
    '# Outreach judge calibration — blind ranking sheet',
    '',
    `Rank these ${rows.length} drafts best (1) to worst (${rows.length}) on overall quality`,
    '(grounding, tone, one clear ask, no fabrication). Put your rank next to each id in a',
    'JSON file `{ "<id>": <rank>, ... }` and run `--mode=score --ranking=<that file>`.',
    '',
  ];
  for (const r of rows) {
    mdLines.push(`## ${r.id}`, `**Subject:** ${r.subject}`, '', r.body, '', '---', '');
  }
  const scores: Record<string, number> = {};
  for (const r of rows) scores[r.id] = r.judgeAvg;

  const mdPath = join(reportsDir(), `outreach-calibration-${ts}.md`);
  const scoresPath = join(reportsDir(), 'outreach-calibration-scores.json');
  writeFileSync(mdPath, mdLines.join('\n'));
  writeFileSync(scoresPath, JSON.stringify(scores, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${rows.length} drafts.\n  Ranking sheet → ${mdPath}\n  Judge scores → ${scoresPath}`,
  );
  // eslint-disable-next-line no-console
  console.log('Next: rank the sheet into a JSON {id->rank}, then --mode=score --ranking=<file>.');
}

function score(rankingPath: string): void {
  const ranking = JSON.parse(readFileSync(rankingPath, 'utf-8')) as Record<string, number>;
  const scoresPath = join(reportsDir(), 'outreach-calibration-scores.json');
  const judgeScores = JSON.parse(readFileSync(scoresPath, 'utf-8')) as Record<string, number>;
  // Judge higher-is-better → higher-is-better numeric; Ninja rank 1=best → invert
  // so both are "higher = better" before correlating.
  const n = Object.keys(ranking).length;
  const ninjaGoodness: Record<string, number> = {};
  for (const [id, rank] of Object.entries(ranking)) ninjaGoodness[id] = n - rank;
  const rho = spearman(judgeScores, ninjaGoodness);
  const pass = rho >= 0.7;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(reportsDir(), `outreach-calibration-report-${ts}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), n, spearman: rho, pass, ranking, judgeScores },
      null,
      2,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(
    `Spearman(judge, ninja) = ${rho.toFixed(3)} over n=${n} — ${pass ? 'PASS (>=0.7)' : 'BELOW 0.7: iterate the judge rubric'}`,
  );
  // eslint-disable-next-line no-console
  console.log(`Report → ${outPath}`);
  if (!pass) process.exit(2); // signal "not yet calibrated" without looking like a crash
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'emit') {
    if (!args.report) throw new Error('--report=<eval-report.json> required for --mode=emit');
    emit(args.report);
  } else if (args.mode === 'score') {
    if (!args.ranking) throw new Error('--ranking=<ninja-ranking.json> required for --mode=score');
    score(args.ranking);
  } else {
    throw new Error('Usage: --mode=emit --report=<path> | --mode=score --ranking=<path>');
  }
}

// Run only when invoked directly (so the pure helpers can be imported by a spec).
// Under jest, process.argv[1] is the jest binary (≠ this module) so main() stays
// dormant; under tsx it is this script's path.
if (process.argv[1] && __filename === process.argv[1]) {
  main();
}
