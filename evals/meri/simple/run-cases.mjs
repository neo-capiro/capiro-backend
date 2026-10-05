// Simplified acceptance runner (docs/meri/implementation/01-Meri-Acceptance-Simplified-2026-10-05.md).
// Signs in as neo@capiro.ai in capiro-internal, opens a conversation per case
// with the case's client selected, sends each turn through the ordinary stream
// endpoint the web app uses, saves everything, and runs the automatic checks.
// One turn at a time. Never approves or dismisses anything.
//
//   node evals/meri/simple/run-cases.mjs --cases 01,05 --out C:/dev/main/outputs/meri-simple-20261005/capiro-internal
import { mkdirSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cases as originals } from '../live-v1/cases.mjs';
import { internalCases } from './capiro-internal-cases.mjs';
import { withTestAccount, TENANT } from './auth.mjs';
import { runChecks } from './checks.mjs';
import { turnCostMicros } from './cost.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const out = arg('out', 'C:/dev/main/outputs/meri-simple-20261005/capiro-internal');
const wanted = new Set(arg('cases', '').split(',').filter(Boolean));
const selected = internalCases.filter((c) => wanted.has(c.id));
if (!selected.length) throw new Error('no cases selected (--cases 01,05)');
mkdirSync(out, { recursive: true });
const save = (dir, name, value) =>
  writeFileSync(`${dir}/${name}`, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');

function parseStream(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      events.push(JSON.parse(line.slice(6)));
    } catch {
      /* keep-alive or partial line */
    }
  }
  return {
    text: events.filter((e) => e.type === 'text').map((e) => e.text ?? e.delta ?? '').join(''),
    usage: events.findLast((e) => e.type === 'usage')?.usage ?? null,
    done: events.findLast((e) => e.type === 'done') ?? null,
    tools: [...new Set(events.filter((e) => e.type === 'sources').flatMap((e) => e.sources ?? []).map((s) => s.tool))],
    error: events.find((e) => e.type === 'error') ?? null,
  };
}

async function runCase(c, session, clients) {
  const original = originals.find((o) => o.id === c.id);
  const dir = `${out}/case-${c.id}`;
  mkdirSync(dir, { recursive: true });
  const attempt = readdirSync(dir).filter((n) => n.startsWith('attempt-')).length + 1;
  const adir = `${dir}/attempt-${attempt}`;
  mkdirSync(adir);
  const clientId = c.client ? clients[c.client] : null;
  if (c.client && !clientId) throw new Error(`CLIENT_NOT_FOUND_${c.client}`);
  const conversation = await session.json('/api/clio/conversations', 'POST', {
    ...(clientId ? { clientId } : {}),
    title: `[acceptance] case ${c.id} attempt ${attempt}`,
  });
  const turns = [];
  for (const [index, turn] of c.turns.entries()) {
    if (turn.switchClient) {
      const next = clients[turn.switchClient];
      if (!next) throw new Error(`CLIENT_NOT_FOUND_${turn.switchClient}`);
      await session.json(`/api/clio/conversations/${conversation.id}`, 'PATCH', { clientId: next });
    }
    const startedAt = new Date().toISOString();
    const response = await session.request(`/api/clio/conversations/${conversation.id}/stream`, 'POST',
      { body: turn.prompt }, 15 * 60_000);
    const raw = await response.text();
    save(adir, `stream-${index + 1}.txt`, raw);
    const parsed = parseStream(raw);
    turns.push({ prompt: turn.prompt, client: turn.switchClient ?? c.client, startedAt, httpStatus: response.status,
      apiRelease: response.headers.get('x-capiro-release-sha'), answer: parsed.text, tools: parsed.tools,
      usage: parsed.usage, done: parsed.done && { finishReason: parsed.done.finishReason, partial: parsed.done.partial,
        model: parsed.done.model }, streamError: parsed.error, mustNotMention: turn.mustNotMention ?? [] });
  }
  const messages = await session.json(`/api/clio/conversations/${conversation.id}/messages`);
  const proposals = (await session.json(`/api/clio/action-proposals?conversationId=${conversation.id}`)) ?? [];
  const list = Array.isArray(messages) ? messages : messages?.messages ?? [];
  const assistants = list.filter((m) => m.role === 'assistant');
  turns.forEach((t, i) => {
    const m = assistants[i];
    if (m?.body ?? m?.content) t.answer = m.body ?? m.content;
    t.citations = m?.citations ?? m?.metadata?.citations ?? [];
  });
  const run = {
    caseId: c.id, attempt, tenant: TENANT.slug, client: c.client, conversationId: conversation.id,
    originalPrompt: original?.prompt, passCondition: original?.hardGates?.[1]?.assertion, reference: c.reference ?? null, turns,
    estimatedCostMicros: turns.reduce((n, t) => n + turnCostMicros(t.done?.model, t.usage), 0),
    proposals: (Array.isArray(proposals) ? proposals : proposals.items ?? []).map((p) => ({
      id: p.proposalId ?? p.id, tool: p.tool ?? p.kind, status: p.status })),
    finishedAt: new Date().toISOString(),
  };
  save(adir, 'messages.json', messages);
  save(adir, 'proposals.json', proposals);
  const graded = { ...run, ...runChecks(c, run, original, Object.keys(clients)), humanVerdict: null };
  save(adir, 'result.json', graded);
  appendFileSync(`${out}/results.jsonl`, JSON.stringify(graded) + '\n');
  return graded;
}

for (const c of selected.filter((x) => x.mode !== 'LIVE'))
  console.log(JSON.stringify({ caseId: c.id, mode: c.mode, why: c.why }));
const live = selected.filter((x) => x.mode === 'LIVE');
appendFileSync(`${out}/batches.jsonl`, JSON.stringify({ batchId: randomUUID(), at: new Date().toISOString(),
  cases: live.map((c) => c.id) }) + '\n');
await withTestAccount(async (session) => {
  const listed = await session.json('/api/clients');
  const rows = Array.isArray(listed) ? listed : listed?.data ?? listed?.items ?? listed?.clients ?? [];
  const clients = Object.fromEntries(rows.map((r) => [r.name, r.id]));
  for (const c of live) {
    try {
      const r = await runCase(c, session, clients);
      console.log(JSON.stringify({ caseId: c.id, attempt: r.attempt, verdict: r.verdict,
        checks: r.checks.map((x) => `${x.id}:${x.status}`).join(' '), costUsd: (r.estimatedCostMicros / 1e6).toFixed(2),
        answer: String(r.turns.at(-1)?.answer ?? '').replace(/\s+/g, ' ').slice(0, 200) }));
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      console.log(JSON.stringify({ caseId: c.id, error: message }));
      appendFileSync(`${out}/results.jsonl`, JSON.stringify({ caseId: c.id, error: message, at: new Date().toISOString() }) + '\n');
    }
  }
});
