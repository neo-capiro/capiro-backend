// Re-runs the automatic checks on saved results (no provider calls) after a
// check fix, rewriting each latest attempt's result.json and a fresh summary.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { cases as originals } from './original-cases.mjs';
import { internalCases } from './capiro-internal-cases.mjs';
import { runChecks } from './checks.mjs';
import { turnCostMicros } from './cost.mjs';

const out = process.argv[2] ?? 'C:/dev/main/outputs/meri-simple-20261005/capiro-internal';
const clients = JSON.parse(readFileSync(`${out}/inventory.json`, 'utf8')).clients.map((c) => c.name);
const summary = [];
for (const dir of readdirSync(out).filter((d) => d.startsWith('case-')).sort()) {
  const attempts = readdirSync(`${out}/${dir}`).filter((a) => a.startsWith('attempt-')).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
  const path = `${out}/${dir}/${attempts.at(-1)}/result.json`;
  if (!existsSync(path)) continue;
  const run = JSON.parse(readFileSync(path, 'utf8'));
  const c = internalCases.find((x) => x.id === run.caseId);
  run.estimatedCostMicros = run.turns.reduce((n, x) => n + turnCostMicros(x.done?.model, x.usage), 0);
  const graded = { ...run, ...runChecks(c, run, originals.find((o) => o.id === run.caseId), clients) };
  writeFileSync(path, JSON.stringify(graded, null, 2) + '\n');
  summary.push({ caseId: run.caseId, attempt: run.attempt, verdict: graded.verdict,
    checks: graded.checks.map((x) => `${x.id}:${x.status}`).join(' '), costUsd: +(run.estimatedCostMicros / 1e6).toFixed(2),
    humanVerdict: run.humanVerdict ?? null });
}
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
for (const s of summary) console.log(JSON.stringify(s));
