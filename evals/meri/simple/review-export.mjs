// Writes one review document per case (latest attempt) for the review page's
// `cases` collection: prompts, answers, checks and cost. Nothing is sent here.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { cases as originals } from './original-cases.mjs';

const FAMILY = [[12, 'Memory and scope'], [19, 'In-Meri memory review'], [27, 'Budget and Program Elements'],
  [34, 'Bills and congressional direction'], [39, 'Opportunities and eligibility'], [46, 'Files and artifacts'],
  [51, 'Meetings and approved actions'], [58, 'Web, JEV and narrative'], [63, 'Research Portfolios'],
  [67, 'Business Development'], [70, 'District Nexus'], [75, 'Bounded execution and recovery']];
const family = (id) => (/^CD/.test(id) ? 'Commitments & Deliverables' : FAMILY.find(([max]) => Number(id) <= max)?.[1] ?? '');
const [, , src = 'C:/dev/main/outputs/meri-simple-20261005/capiro-internal', dest] = process.argv;
mkdirSync(dest, { recursive: true });
const written = [];
for (const dir of readdirSync(src).filter((d) => d.startsWith('case-')).sort()) {
  const attempts = readdirSync(`${src}/${dir}`).filter((a) => a.startsWith('attempt-'))
    .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
  const path = `${src}/${dir}/${attempts.at(-1)}/result.json`;
  if (!existsSync(path)) continue;
  const r = JSON.parse(readFileSync(path, 'utf8'));
  const o = originals.find((x) => x.id === r.caseId);
  const doc = {
    family: family(r.caseId), client: r.client ?? null, attempt: r.attempt, costUsd: +(r.estimatedCostMicros / 1e6).toFixed(2),
    originalPrompt: o?.prompt ?? null, passCondition: r.passCondition ?? o?.hardGates?.[1]?.assertion ?? null,
    reference: r.reference ?? null,
    turns: r.turns.map((t) => ({ prompt: t.prompt, client: t.client ?? null, answer: String(t.answer ?? '').slice(0, 60000),
      citations: (t.citations ?? []).length, tools: t.tools ?? [] })),
    checks: r.checks, autoVerdict: r.verdict, conversationId: r.conversationId, finishedAt: r.finishedAt,
  };
  writeFileSync(`${dest}/${r.caseId}.json`, JSON.stringify(doc) + '\n');
  written.push(r.caseId);
}
console.log(JSON.stringify(written));
