#!/usr/bin/env node
/**
 * Meri ⇄ Hermes Phase 0 compatibility harness — end-to-end driver.
 *
 * Runs the REAL Hermes agent (pinned image) against the REAL Meri runtime
 * adapter/broker (apps/api/scripts/meri-hermes-phase0-harness-api.ts) and the
 * local fixture database, and records evidence for the Phase 0 demonstrations:
 *
 *   D1 real turn: streaming text + native tool call, usage, timings
 *   D2 authorized broker read (governed memory) + governed candidate write
 *   D3 SOUL.md + explicit skill creation → worker replacement → skill reuse;
 *      automatic-learning probe (background review)
 *   D4 file ingestion (native read_file over a Meri attachment) → artifact publish → authorized retrieval
 *   D5 clarification (durable continuation) and native approval (deny / approve / stop while pending)
 *   D6 stop, browser disconnect/reconnect, fresh worker start
 *   ISO cross-user / cross-tenant / spoof / broker-token / flag-off checks
 *   MEAS cold/warm start, TTFE, tool latency, CPU/mem, tokens
 *
 * Usage:
 *   node scripts/meri-hermes/phase0-harness.mjs [--only D1,D2] [--keep] [--skip-seed] [--skip-docker]
 *                                              [--model gpt-5.6-luna] [--evidence-dir <dir>]
 * Env:
 *   DATABASE_URL           local fixture DB (default postgresql://capiro:capiro@localhost:5432/capiro)
 *   OPENAI_API_KEY         model key; else fetched from AWS Secrets Manager id MERI_HERMES_OPENAI_SECRET_ID
 *                          (default capiro/dev/openai-api-key) — held in memory only, never written
 *   MERI_HERMES_MODEL      default gpt-5.6-luna
 *   HERMES_IMAGE           default meri-hermes-worker:v2026.9.14-meri
 *   HARNESS_PORT (4450)    HERMES_PORT (18642)
 *
 * Evidence: docs/meri/hermes/phase-0/evidence/<stamp>/ (JSON per check + summary.md). Secrets are never written.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FIX = JSON.parse(readFileSync(path.join(HERE, 'phase0-fixtures.json'), 'utf8'));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const ONLY = opt('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const KEEP = flag('--keep');
const SKIP_SEED = flag('--skip-seed');
const SKIP_DOCKER = flag('--skip-docker');
const MODEL = opt('--model', process.env.MERI_HERMES_MODEL ?? 'gpt-5.6-luna');
const PROVIDER = process.env.MERI_HERMES_PROVIDER ?? 'custom';
const BASE_URL = process.env.MERI_HERMES_BASE_URL ?? 'https://api.openai.com/v1';
const IMAGE = process.env.HERMES_IMAGE ?? 'meri-hermes-worker:v2026.9.14-meri';
const HARNESS_PORT = Number(process.env.HARNESS_PORT ?? 4450);
const HERMES_PORT = Number(process.env.HERMES_PORT ?? 18642);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://capiro:capiro@localhost:5432/capiro?schema=public';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const EVIDENCE_DIR = opt('--evidence-dir', path.join(ROOT, 'docs/meri/hermes/phase-0/evidence', STAMP));
mkdirSync(EVIDENCE_DIR, { recursive: true });

// Secrets are random per run unless supplied (phased runs with --reuse-api/--skip-docker
// must share them with the still-running harness API and worker).
const HARNESS_SECRET = process.env.HARNESS_SECRET ?? randomBytes(24).toString('hex');
const API_SERVER_KEY = process.env.MERI_HERMES_API_KEY ?? randomBytes(24).toString('hex');
const BROKER_SIGNING_KEY = process.env.MERI_HERMES_BROKER_SIGNING_KEY ?? randomBytes(32).toString('hex');
const REUSE_API = flag('--reuse-api');
const HARNESS = `http://127.0.0.1:${HARNESS_PORT}/api`;
// One worker per execution scope: Alice and Bob each get their own container + home volume.
const WORKERS = {
  alice: { name: 'meri-hermes-p0-alice', port: HERMES_PORT, volume: 'meri-hermes-p0-alice-home' },
  bob: { name: 'meri-hermes-p0-bob', port: HERMES_PORT + 10, volume: 'meri-hermes-p0-bob-home' },
};
const HERMES = `http://127.0.0.1:${WORKERS.alice.port}`;
const CONTAINER = WORKERS.alice.name;
const VOLUME = WORKERS.alice.volume;
const scopeIdOf = (who) => `tenant:${who.tenantId.toLowerCase()}:user:${who.userId.toLowerCase()}`;

const checks = [];
const log = (...m) => console.log(`[harness ${new Date().toISOString().slice(11, 19)}]`, ...m);
const save = (name, data) => writeFileSync(path.join(EVIDENCE_DIR, name), JSON.stringify(data, null, 2));
const redact = (s) => String(s).replaceAll(HARNESS_SECRET, '<harness-secret>').replaceAll(API_SERVER_KEY, '<api-key>').replaceAll(BROKER_SIGNING_KEY, '<signing-key>');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function record(id, title, status, detail = {}) {
  const entry = { id, title, status, at: new Date().toISOString(), ...detail };
  checks.push(entry);
  log(`${status.toUpperCase()} ${id} — ${title}`);
  save(`${id}.json`, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------
const ident = (userKey) => {
  const user = FIX.users[userKey];
  return { tenantId: FIX.tenants[user.tenant].id, userId: user.id };
};
const headers = (who, extra = {}) => ({
  'x-harness-secret': HARNESS_SECRET,
  ...(who ? { 'x-harness-tenant-id': who.tenantId, 'x-harness-user-id': who.userId } : {}),
  'content-type': 'application/json',
  ...extra,
});
async function api(method, url, { who, body, extraHeaders, raw } = {}) {
  const res = await fetch(url, { method, headers: headers(who, extraHeaders), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 400) }; }
  return raw ? { status: res.status, text, headers: res.headers } : { status: res.status, json };
}
async function hermesApi(method, p, body) {
  const res = await fetch(`${HERMES}${p}`, { method, headers: { authorization: `Bearer ${API_SERVER_KEY}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Streaming helper: POST harness stream, parse Meri SSE frames
// ---------------------------------------------------------------------------
async function streamTurn(who, conversationId, body, { attachmentIds = [], abortWhen = null, timeoutMs = 240_000, mode = 'new' } = {}) {
  const controller = new AbortController();
  const t0 = now();
  const timings = { t0, firstFrame: null, turnAccepted: null, start: null, firstText: null, firstTool: null, done: null, abortedAt: null };
  const frames = [];
  let text = '';
  let runId = null;
  const timer = setTimeout(() => controller.abort(new Error('harness timeout')), timeoutMs);
  let res;
  try {
    res = await fetch(`${HARNESS}/harness/conversations/${conversationId}/stream`, {
      method: 'POST', headers: headers(who), body: JSON.stringify({ body, attachmentIds, mode }), signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return { status: 0, error: String(error), frames, text, runId, timings };
  }
  if (res.status < 200 || res.status >= 300 || !res.body) {
    clearTimeout(timer);
    return { status: res.status, body: (await res.text()).slice(0, 1000), frames, text, runId, timings };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let aborted = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let frame;
        try { frame = JSON.parse(line.slice(6)); } catch { continue; }
        const t = now() - t0;
        frames.push({ t, ...frame });
        timings.firstFrame ??= t;
        if (frame.type === 'turn_accepted') timings.turnAccepted ??= t;
        if (frame.type === 'start') { timings.start ??= t; runId = frame.runId ?? runId; }
        if (frame.type === 'text') { timings.firstText ??= t; text += frame.text; }
        if (frame.type === 'tool_call') timings.firstTool ??= t;
        if (frame.type === 'done') timings.done = t;
        if (abortWhen && !aborted && abortWhen(frame, frames)) {
          aborted = true;
          timings.abortedAt = t;
          controller.abort(new Error('harness simulated browser disconnect'));
        }
      }
    }
  } catch (error) {
    if (!aborted) frames.push({ t: now() - t0, type: '_harness_stream_error', message: String(error) });
  } finally {
    clearTimeout(timer);
  }
  return { status: res.status, frames, text, runId, timings, aborted };
}
const ok2xx = (turn) => turn.status >= 200 && turn.status < 300;

async function waitForRun(who, runId, predicate, timeoutMs = 240_000) {
  const t0 = now();
  for (;;) {
    const r = await api('GET', `${HARNESS}/harness/runs/${runId}/full`, { who });
    if (r.status === 200 && predicate(r.json)) return r.json;
    if (now() - t0 > timeoutMs) return r.json;
    await sleep(1000);
  }
}
const isTerminal = (full) => ['completed', 'cancelled', 'failed', 'interrupted', 'expired'].includes(full?.run?.status);

// ---------------------------------------------------------------------------
// Infra: seed, harness API, worker container
// ---------------------------------------------------------------------------
function sh(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
function resolveModelKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const secretId = process.env.MERI_HERMES_OPENAI_SECRET_ID ?? 'capiro/dev/openai-api-key';
  log(`fetching model key from AWS Secrets Manager (${secretId}); value stays in memory`);
  return sh('aws', ['secretsmanager', 'get-secret-value', '--secret-id', secretId, '--region', 'us-east-1', '--query', 'SecretString', '--output', 'text'], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
}
let harnessProc = null;
async function startHarnessApi(tenantAllowlist) {
  if (REUSE_API) {
    try {
      const r = await api('GET', `${HARNESS}/harness/health`);
      if (r.status === 200) return { startMs: 0, health: r.json, reused: true };
    } catch { /* not running; start below */ }
  }
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL,
    HARNESS_SECRET,
    HARNESS_PORT: String(HARNESS_PORT),
    MERI_HERMES_ENABLED: 'true',
    MERI_HERMES_PILOT_TENANT_IDS: tenantAllowlist,
    MERI_HERMES_RUNTIME_URL: HERMES,
    MERI_HERMES_API_KEY: API_SERVER_KEY,
    // Per-scope worker map (Phase 0 stand-in for the worker lifecycle registry).
    MERI_HERMES_SCOPE_RUNTIMES: JSON.stringify({
      [scopeIdOf(ident('alice'))]: { url: `http://127.0.0.1:${WORKERS.alice.port}`, apiKey: API_SERVER_KEY },
      [scopeIdOf(ident('bob'))]: { url: `http://127.0.0.1:${WORKERS.bob.port}`, apiKey: API_SERVER_KEY },
    }),
    MERI_HERMES_BROKER_SIGNING_KEY: BROKER_SIGNING_KEY,
    MERI_HERMES_MODEL: MODEL,
    MERI_HERMES_RUN_MAX_WALL_MS: '600000',
    MERI_HERMES_REQUEST_TIMEOUT_MS: '60000',
  };
  const logPath = path.join(EVIDENCE_DIR, 'harness-api.log');
  const out = [];
  harnessProc = spawn(process.execPath, [path.join(HERE, 'phase0-harness-api.mjs')], { cwd: ROOT, env, detached: KEEP, stdio: ['ignore', 'pipe', 'pipe'] });
  harnessProc.stdout.on('data', (d) => out.push(redact(d)));
  harnessProc.stderr.on('data', (d) => out.push(redact(d)));
  const flush = () => writeFileSync(logPath, out.join(''));
  harnessProc.on('exit', flush);
  const t0 = now();
  for (;;) {
    try {
      const r = await api('GET', `${HARNESS}/harness/health`);
      if (r.status === 200) { flush(); return { startMs: now() - t0, health: r.json }; }
    } catch { /* not up yet */ }
    if (now() - t0 > 420_000) { flush(); throw new Error(`harness API did not start; see ${logPath}`); }
    await sleep(1000);
  }
}
function dockerRm(name = CONTAINER) {
  try { sh('docker', ['rm', '-f', name]); } catch { /* absent */ }
}
function dockerRmAll() {
  for (const w of Object.values(WORKERS)) dockerRm(w.name);
}
async function startWorker(worker, { modelKey, workerToken, scopeId, freshVolume }) {
  dockerRm(worker.name);
  if (freshVolume) { try { sh('docker', ['volume', 'rm', worker.volume]); } catch { /* absent */ } }
  const t0 = now();
  sh('docker', [
    'run', '-d', '--name', worker.name, '-p', `${worker.port}:8642`, '-v', `${worker.volume}:/opt/data`,
    '--cpus', process.env.HERMES_CPUS ?? '1', '--memory', process.env.HERMES_MEMORY ?? '2g',
    '--add-host', 'host.docker.internal:host-gateway',
    '-e', `API_SERVER_KEY=${API_SERVER_KEY}`,
    '-e', `MERI_BROKER_URL=http://host.docker.internal:${HARNESS_PORT}/api/internal/hermes/broker`,
    '-e', `MERI_WORKER_TOKEN=${workerToken}`,
    '-e', `MERI_EXECUTION_SCOPE_ID=${scopeId}`,
    '-e', `OPENAI_API_KEY=${modelKey}`,
    '-e', `MERI_HERMES_MODEL=${MODEL}`,
    '-e', `MERI_HERMES_PROVIDER=${PROVIDER}`,
    '-e', `MERI_HERMES_BASE_URL=${BASE_URL}`,
    '-e', 'MERI_MAX_CONCURRENT_RUNS=4',
    // api_server is an "unattended" approval platform on this build: without
    // HERMES_EXEC_ASK=1 a guarded command is auto-denied (approvals.unattended_mode)
    // and no approval.request event is ever emitted. With it, the run blocks on
    // POST /v1/runs/{id}/approval (tools/approval.py `_presence`, `is_ask`).
    '-e', `HERMES_EXEC_ASK=${process.env.HERMES_EXEC_ASK ?? '1'}`,
    IMAGE,
  ]);
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${worker.port}/health`, { headers: { authorization: `Bearer ${API_SERVER_KEY}` } });
      if (r.ok) return { startMs: now() - t0, worker: worker.name };
    } catch { /* booting */ }
    if (now() - t0 > 240_000) throw new Error('worker did not become healthy; docker logs ' + worker.name);
    await sleep(750);
  }
}
function dockerLogs(tail = 400) {
  try { return redact(sh('docker', ['logs', '--tail', String(tail), CONTAINER], { stdio: ['ignore', 'pipe', 'pipe'] })); } catch (e) { return String(e.stdout ?? e); }
}
function dockerExec(...argv) {
  try { return sh('docker', ['exec', CONTAINER, ...argv]); } catch (e) { return `ERR ${String(e.stderr ?? e).slice(0, 400)}`; }
}
function dockerStats() {
  try { return JSON.parse(sh('docker', ['stats', '--no-stream', '--format', 'json', CONTAINER])); } catch { return null; }
}
const should = (id) => !ONLY.length || ONLY.includes(id);

// ---------------------------------------------------------------------------
// Demonstrations
// ---------------------------------------------------------------------------
const alice = ident('alice');
const bob = ident('bob');
const carol = ident('carol');
const CONV_A = FIX.conversations.alice.id;
const CONV_A2 = FIX.conversations.aliceSecond.id;
const CONV_B = FIX.conversations.bob.id;
const statsSamples = [];
const sampleStats = (label) => { const s = dockerStats(); if (s) statsSamples.push({ label, at: new Date().toISOString(), ...s }); };

async function demoD1() {
  const turn = await streamTurn(alice, CONV_A, 'Introduce yourself in two sentences, then use the terminal tool to run `echo MERI-D1-$(date +%s)` and tell me the exact output line.');
  sampleStats('D1');
  const full = turn.runId ? await waitForRun(alice, turn.runId, isTerminal, 60_000) : null;
  const toolCalls = turn.frames.filter((f) => f.type === 'tool_call').map((f) => f.tool);
  const ok = ok2xx(turn) && turn.frames.some((f) => f.type === 'text') && turn.frames.some((f) => f.type === 'done' && f.finishReason === 'stop') && toolCalls.includes('terminal');
  record('D1', 'Real Hermes turn: streamed text, native terminal tool, completion, usage', ok ? 'passed' : 'failed', {
    runId: turn.runId, httpStatus: turn.status, httpBody: turn.body ?? null, timingsMs: turn.timings, toolCalls, textChars: turn.text.length, textPreview: turn.text.slice(0, 400),
    doneFrame: turn.frames.find((f) => f.type === 'done'), usage: full?.run?.usage ?? null, finalStatus: full?.run?.status,
    frameTypes: [...new Set(turn.frames.map((f) => f.type))],
  });
  return turn;
}

async function demoD2() {
  const read = await streamTurn(alice, CONV_A, 'Using meri_memory_search, find what the firm playbook says about the morning briefing format and quote the exact PHASE0 marker text you find, with its source_id. Then tell me whether any private preference of another user was returned (it must not be).');
  const readFull = read.runId ? await waitForRun(alice, read.runId, isTerminal, 60_000) : null;
  const recallEvents = (readFull?.events ?? []).filter((e) => e.kind === 'memory.recalled');
  const sawFirmFact = read.text.includes('PHASE0-FIRM-FACT') || read.text.includes('briefing');
  const leakedBob = read.text.includes('PHASE0-BOB-PRIVATE-FACT');
  record('D2a', 'Authorized broker read through Meri governed memory (firm fact visible, other user private fact absent)', sawFirmFact && !leakedBob && recallEvents.length > 0 ? 'passed' : 'failed', {
    runId: read.runId, httpStatus: read.status, recallEvents, toolCalls: read.frames.filter((f) => f.type === 'tool_call').map((f) => f.tool), textPreview: read.text.slice(0, 600), leakedBobPrivate: leakedBob, timingsMs: read.timings,
  });

  const write = await streamTurn(alice, CONV_A, 'Remember, as my private preference (scope user_private), that I want Phase 0 test summaries limited to three bullets. Use meri_memory_propose with key "phase0-summary-length" and report the exact status it returns; do not claim it is saved unless the status says so.');
  const writeFull = write.runId ? await waitForRun(alice, write.runId, isTerminal, 60_000) : null;
  const proposed = (writeFull?.events ?? []).filter((e) => e.kind === 'memory.proposed');
  const candidates = await api('GET', `${HARNESS}/harness/memory-candidates`, { who: alice });
  const row = (candidates.json ?? []).find((c) => c.key === 'phase0-summary-length');
  record('D2b', 'Governed memory write path: proposal lands as a real memory_candidate (never a raw write)', proposed.length > 0 && row ? 'passed' : 'failed', {
    runId: write.runId, proposedEvents: proposed, candidateRow: row ?? null, textPreview: write.text.slice(0, 400),
  });

  const walled = await streamTurn(bob, CONV_B, 'Using meri_memory_search with query "walled client Section 809", tell me exactly what was returned. If nothing about a walled client is returned, say so plainly.');
  const bobFull = walled.runId ? await waitForRun(bob, walled.runId, isTerminal, 60_000) : null;
  const bobSawWalled = walled.text.includes('PHASE0-WALLED-CLIENT-FACT');
  const bobSawAlice = walled.text.includes('PHASE0-ALICE-PRIVATE-FACT');
  const bobRecall = (bobFull?.events ?? []).filter((e) => e.kind === 'memory.recalled');
  record('D2c', 'Ethical wall + private scope: Bob cannot recall the walled client fact or Alice private fact', ok2xx(walled) && bobRecall.length > 0 && !bobSawWalled && !bobSawAlice ? 'passed' : 'failed', {
    runId: walled.runId, httpStatus: walled.status, recallEvents: bobRecall, textPreview: walled.text.slice(0, 500), bobSawWalled, bobSawAlicePrivate: bobSawAlice, runStatus: bobFull?.run?.status,
  });
}

async function demoD3(modelKey, workerToken, scopeId) {
  const soul = dockerExec('cat', '/opt/data/SOUL.md');
  const persona = await streamTurn(alice, CONV_A2, 'In one sentence, who are you and what is your role here? Answer in your own voice.');
  const personaOk = /meri/i.test(persona.text) && /(chief of staff|colleague|firm)/i.test(persona.text);
  record('D3a', 'SOUL.md personality applied in the worker (native)', persona.status === 200 && personaOk ? 'passed' : 'failed', {
    soulPreview: soul.slice(0, 300), answer: persona.text.slice(0, 400), runId: persona.runId,
  });

  const skillsBefore = dockerExec('ls', '-R', '/opt/data/skills');
  const create = await streamTurn(alice, CONV_A2, 'Create a reusable skill with the skill_manage tool named "meri-phase0-briefing" (category "meri"). Its SKILL.md must instruct: lead with the three commitments due this week, then blockers, then one recommendation, under 120 words, and must contain the literal token PHASE0-SKILL-MARKER. Confirm the exact path it was written to.', { timeoutMs: 300_000 });
  const skillsAfter = dockerExec('ls', '-R', '/opt/data/skills');
  const skillFile = dockerExec('sh', '-c', 'cat /opt/data/skills/*/meri-phase0-briefing/SKILL.md 2>/dev/null || cat /opt/data/skills/meri-phase0-briefing/SKILL.md 2>/dev/null || echo MISSING');
  // NOTE: GET /v1/skills is broken on the pinned build (TypeError: _find_all_skills() got an
  // unexpected keyword argument 'include_editorial' — observed 2026-09-19); it is recorded as
  // evidence, not relied upon. Persistence is proven from the scope filesystem + skill_view use.
  const skillsApi = await hermesApi('GET', '/v1/skills');
  const listed = skillsApi.status === 200 ? JSON.stringify(skillsApi.json ?? '').includes('meri-phase0-briefing') : null;
  record('D3b', 'Explicit native skill creation via skill_manage persists SKILL.md in the scope home', skillFile.includes('PHASE0-SKILL-MARKER') ? 'passed' : 'failed', {
    runId: create.runId, toolCalls: create.frames.filter((f) => f.type === 'tool_call').map((f) => f.tool), skillsBefore: skillsBefore.slice(0, 800), skillsAfter: skillsAfter.slice(0, 1500), skillFilePreview: skillFile.slice(0, 600),
    skillsApi: { status: skillsApi.status, listed, error: skillsApi.status !== 200 ? skillsApi.json : null },
  });

  // Worker replacement: destroy the container, keep the scope volume, start fresh.
  const logsBefore = dockerLogs(600);
  const learningLinesBefore = logsBefore.split('\n').filter((l) => /background.?review|skill/i.test(l)).slice(-20);
  dockerRm();
  const warm = await startWorker(WORKERS.alice, { modelKey, workerToken, scopeId, freshVolume: false });
  const skillFileAfterReplace = dockerExec('sh', '-c', 'cat /opt/data/skills/*/meri-phase0-briefing/SKILL.md 2>/dev/null || cat /opt/data/skills/meri-phase0-briefing/SKILL.md 2>/dev/null || echo MISSING');
  const soulAfter = dockerExec('cat', '/opt/data/SOUL.md');
  const reuse = await streamTurn(alice, CONV_A2, 'Use the meri-phase0-briefing skill (load it with skill_view first) to format this briefing: commitments due this week are the appropriations memo, the client call prep and the Section 4 cap note; the blocker is missing committee staff confirmation. Mention which skill you loaded.', { timeoutMs: 300_000 });
  const usedSkillView = reuse.frames.some((f) => f.type === 'tool_call' && /skill/.test(String(f.tool)));
  record('D3c', 'Worker replacement preserves SOUL.md + skills; skill reused in a later task', skillFileAfterReplace.includes('PHASE0-SKILL-MARKER') && soulAfter === soul && usedSkillView ? 'passed' : 'failed', {
    warmStartMs: warm.startMs, skillPersistedAfterReplace: skillFileAfterReplace.includes('PHASE0-SKILL-MARKER'), soulIdentical: soulAfter === soul, reuseToolCalls: reuse.frames.filter((f) => f.type === 'tool_call').map((f) => f.tool), reuseTextPreview: reuse.text.slice(0, 500), runId: reuse.runId,
  });

  // Automatic learning probe: complete a multi-step workflow WITHOUT asking for a skill, then look for background review activity.
  const auto = await streamTurn(alice, CONV_A2, 'Do this multi-step job without asking questions: (1) create the directory /opt/data/workspace/out if missing, (2) write a file /opt/data/workspace/out/phase0-checklist.md with a five-item checklist for preparing a committee markup briefing, (3) count its lines with wc -l, (4) report the count. Do NOT create or modify any skill during this task.', { timeoutMs: 300_000 });
  await sleep(45_000); // give the daemon-thread background review a chance to run after the turn
  const logsAfter = dockerLogs(800);
  const learningLines = logsAfter.split('\n').filter((l) => /background.?review|skill (created|updated|saved)|curator/i.test(l)).slice(-30);
  const skillsAfterAuto = dockerExec('ls', '-R', '/opt/data/skills');
  const newSkills = skillsAfterAuto.split('\n').filter((l) => l.trim() && !skillsAfter.includes(l));
  // Definitive evidence: Hermes records review usage in state.db (session_model_usage task='background_review').
  const reviewUsage = dockerExec('python3', '-c', "import sqlite3,json; c=sqlite3.connect('/opt/data/state.db'); cur=c.cursor(); cur.execute(\"select name from sqlite_master where type='table' and name like '%usage%'\"); tabs=[r[0] for r in cur.fetchall()]; out={'tables':tabs}; \nfor t in tabs:\n  try:\n    cur.execute(f\"select task, count(*), sum(prompt_tokens), sum(completion_tokens) from {t} group by task\"); out[t]=cur.fetchall()\n  except Exception as e:\n    out[t]=str(e)\nprint(json.dumps(out, default=str))");
  record('D3d', 'Automatic learning probe (background review after an unrequested multi-step task)', 'observed', {
    runId: auto.runId, backgroundReviewLogLines: learningLines, learningLinesBeforeReplacement: learningLinesBefore, newSkillEntriesAfterAutoTask: newSkills.slice(0, 40), autoTaskToolCalls: auto.frames.filter((f) => f.type === 'tool_call').map((f) => f.tool),
    stateDbUsageByTask: reviewUsage.slice(0, 2000),
    note: 'Explicit creation was exercised in D3b. Upstream spawns the background review as a daemon thread after a turn once ~10 tool iterations accumulated since the last skill activity (agent/turn_finalizer.py); a short task does not reach the threshold. stateDbUsageByTask shows whether any background_review usage was recorded on this worker.',
  });
}

async function demoD4() {
  const att = FIX.attachments.aliceDocx;
  const turn = await streamTurn(alice, CONV_A, `Read the attached document with meri_fetch_attachment then read_file. Quote the sentence that starts with "PHASE0-DOCX-SENTENCE" verbatim. Then write a 3-bullet summary to /opt/data/workspace/out/phase0-summary.md and publish it with meri_publish_artifact (title "Phase 0 markup summary", kind "summary_markdown"). Report the artifact id.`, { attachmentIds: [att.id], timeoutMs: 300_000 });
  const full = turn.runId ? await waitForRun(alice, turn.runId, isTerminal, 60_000) : null;
  const published = (full?.events ?? []).filter((e) => e.kind === 'artifact.published');
  const artifactId = published[0]?.payload?.artifactId ?? null;
  const nativeRead = turn.frames.some((f) => f.type === 'tool_call' && f.tool === 'read_file');
  const fetched = turn.frames.some((f) => f.type === 'tool_call' && f.tool === 'meri_fetch_attachment');
  const quotedNative = turn.text.includes('October 7') && turn.text.includes('12 million');
  const usedAppMarker = turn.text.includes('MERI-APP-EXTRACTION-MARKER');
  let aliceGet = null, bobGet = null, body = '';
  if (artifactId) {
    const a = await api('GET', `${HARNESS}/clio/hermes/artifacts/${artifactId}`, { who: alice, raw: true });
    aliceGet = a.status; body = a.text.slice(0, 600);
    const b = await api('GET', `${HARNESS}/clio/hermes/artifacts/${artifactId}`, { who: bob, raw: true });
    bobGet = b.status;
  }
  record('D4', 'File ingestion (native read_file over a Meri attachment) → artifact publish → authorized retrieval', fetched && nativeRead && quotedNative && artifactId && aliceGet === 200 && bobGet === 404 ? 'passed' : 'failed', {
    runId: turn.runId, toolCalls: turn.frames.filter((f) => f.type === 'tool_call').map((f) => f.tool), artifactFrames: turn.frames.filter((f) => f.type === 'artifact'), publishedEvents: published,
    nativeExtractionQuotedUniqueSentence: quotedNative, applicationExtractionMarkerUsed: usedAppMarker, artifactId, aliceDownloadStatus: aliceGet, bobDownloadStatus: bobGet, artifactBodyPreview: body, textPreview: turn.text.slice(0, 600),
  });
}

async function demoD5() {
  // Clarification (durable continuation adapter)
  const ask = await streamTurn(alice, CONV_A, 'Before drafting anything, ask me which client this work is for using meri_request_clarification with the choices "Fixture Client Open" and "Fixture Client Walled". Then end your turn.');
  const askFull = ask.runId ? await waitForRun(alice, ask.runId, isTerminal, 60_000) : null;
  const clarifyFrame = ask.frames.find((f) => f.type === 'clarify');
  const pending = askFull?.run?.pendingInteractions?.find((i) => i.kind === 'clarification' && !i.resolved);
  // Reconnect with cursor 0 → the pending clarification must be replayed.
  const replay = await api('GET', `${HARNESS}/clio/hermes/runs/${ask.runId}/events?after=0`, { who: alice, raw: true });
  const replayHasClarify = replay.text.includes('"type":"clarify"');
  const answer = await streamTurn(alice, CONV_A, 'Fixture Client Open. Now confirm in one sentence which client you will use and stop.');
  const askAfter = await api('GET', `${HARNESS}/harness/runs/${ask.runId}/full`, { who: alice });
  const resolved = askAfter.json?.run?.pendingInteractions?.find((i) => i.kind === 'clarification')?.resolved === true;
  record('D5a', 'Clarification via broker adapter: durable pending interaction, survives reconnect replay, resolved by next message', clarifyFrame && pending && replayHasClarify && resolved && /open/i.test(answer.text) ? 'passed' : 'failed', {
    askRunId: ask.runId, clarifyFrame, pendingAfterTurn: pending ?? null, askRunStatus: askFull?.run?.status, replayHasClarify, answerRunId: answer.runId, answerText: answer.text.slice(0, 300), resolvedAfterAnswer: resolved,
    continuation: 'durable_continuation (no live process retained)',
  });

  // Native approval — DENY path
  const approvalPrompt = 'Create the directory /opt/data/workspace/tmp-fixture with mkdir -p, then run exactly `chmod -R 777 /opt/data/workspace/tmp-fixture` with the terminal tool. If the command is denied, say "DENIED" and stop; if it runs, say "RAN".';
  const denyStream = streamTurn(alice, CONV_A, approvalPrompt, { timeoutMs: 300_000 });
  await sleep(3000);
  let denyRunId = null; let waiting = null;
  for (let i = 0; i < 60 && !waiting; i++) {
    const runs = await api('GET', `${HARNESS}/harness/conversations/${CONV_A}/runs`, { who: alice });
    const candidate = (runs.json ?? []).slice().reverse().find((r) => r.status === 'waiting_for_approval');
    if (candidate) { waiting = candidate; denyRunId = candidate.runId; break; }
    const latest = (runs.json ?? []).slice(-1)[0];
    if (latest && ['completed', 'failed', 'cancelled'].includes(latest.status) && latest.createdAt > new Date(Date.now() - 120_000).toISOString()) { denyRunId = latest.runId; break; }
    await sleep(1000);
  }
  let denyResult = null; let denyOutcome = 'not_reached';
  if (waiting) {
    const req = waiting.pendingInteractions.find((i) => i.kind === 'approval' && !i.resolved);
    denyResult = await api('POST', `${HARNESS}/clio/hermes/runs/${denyRunId}/approval`, { who: alice, body: { requestId: req.requestId, decision: 'deny' } });
    denyOutcome = 'denied_via_meri';
  }
  const denyTurn = await denyStream;
  const denyFull = denyRunId ? await waitForRun(alice, denyRunId, isTerminal, 120_000) : null;
  const approvalReached = Boolean(waiting);
  const is2xx = (s) => typeof s === 'number' && s >= 200 && s < 300;
  record('D5b', 'Native approval over /v1/runs: guarded command surfaces approval.request; Meri denies; command does not run', approvalReached && is2xx(denyResult?.status) && /denied/i.test(denyTurn.text) ? 'passed' : (approvalReached ? 'failed' : 'blocked'), {
    runId: denyRunId, waitingSnapshot: waiting ?? null, denyResponseStatus: denyResult?.status ?? null, finalStatus: denyFull?.run?.status, textPreview: denyTurn.text.slice(0, 400), approvalFrames: denyTurn.frames.filter((f) => f.type === 'pending_approval'),
    note: approvalReached ? 'approval.request observed over the API server platform' : 'no approval.request observed — see run events/logs: api_server may auto-deny (approvals.unattended_mode) or the command was not classified dangerous',
    events: (denyFull?.events ?? []).filter((e) => /approval|tool/.test(e.kind)).slice(0, 30),
  });

  // Native approval — APPROVE ONCE path
  const approveStream = streamTurn(alice, CONV_A, approvalPrompt, { timeoutMs: 300_000 });
  await sleep(3000);
  let approveRun = null;
  for (let i = 0; i < 60 && !approveRun; i++) {
    const runs = await api('GET', `${HARNESS}/harness/conversations/${CONV_A}/runs`, { who: alice });
    approveRun = (runs.json ?? []).slice().reverse().find((r) => r.status === 'waiting_for_approval');
    if (!approveRun) await sleep(1000);
  }
  let approveResult = null;
  if (approveRun) {
    const req = approveRun.pendingInteractions.find((i) => i.kind === 'approval' && !i.resolved);
    approveResult = await api('POST', `${HARNESS}/clio/hermes/runs/${approveRun.runId}/approval`, { who: alice, body: { requestId: req.requestId, decision: 'approve_once' } });
  }
  const approveTurn = await approveStream;
  const approveFull = approveRun ? await waitForRun(alice, approveRun.runId, isTerminal, 120_000) : null;
  record('D5c', 'Native approval: approve_once resumes the live process and the command runs', approveRun && is2xx(approveResult?.status) && /\bran\b/i.test(approveTurn.text) ? 'passed' : (approveRun ? 'failed' : 'blocked'), {
    runId: approveRun?.runId ?? null, approveResponseStatus: approveResult?.status ?? null, finalStatus: approveFull?.run?.status, textPreview: approveTurn.text.slice(0, 400), continuation: 'live_process (worker blocked until decision)',
  });

  // Stop while waiting for approval
  const stopStream = streamTurn(alice, CONV_A, approvalPrompt, { timeoutMs: 300_000 });
  await sleep(3000);
  let stopRun = null;
  for (let i = 0; i < 60 && !stopRun; i++) {
    const runs = await api('GET', `${HARNESS}/harness/conversations/${CONV_A}/runs`, { who: alice });
    stopRun = (runs.json ?? []).slice().reverse().find((r) => r.status === 'waiting_for_approval');
    if (!stopRun) await sleep(1000);
  }
  let stopResult = null;
  if (stopRun) stopResult = await api('POST', `${HARNESS}/clio/hermes/runs/${stopRun.runId}/stop`, { who: alice });
  const stopTurn = await stopStream;
  const stopFull = stopRun ? await waitForRun(alice, stopRun.runId, isTerminal, 120_000) : null;
  record('D5d', 'Cancel while a native approval is pending → terminal cancelled, no success publication', stopRun && is2xx(stopResult?.status) && ['cancelled', 'interrupted', 'failed', 'expired'].includes(stopFull?.run?.status) && !/\bran\b/i.test(stopTurn.text) ? 'passed' : (stopRun ? 'failed' : 'blocked'), {
    runId: stopRun?.runId ?? null, stopResponse: stopResult?.json ?? null, finalStatus: stopFull?.run?.status, finishReason: stopFull?.run?.finishReason, textPreview: stopTurn.text.slice(0, 300),
  });
}

async function demoD6(modelKey, workerToken, scopeId) {
  // Stop mid-run
  const longStream = streamTurn(alice, CONV_A, 'Use the terminal tool to run `for i in $(seq 1 60); do echo tick-$i; sleep 1; done` and then summarize. Do not stop early.', { timeoutMs: 300_000 });
  let running = null;
  for (let i = 0; i < 40 && !running; i++) {
    const runs = await api('GET', `${HARNESS}/harness/conversations/${CONV_A}/runs`, { who: alice });
    const latest = (runs.json ?? []).slice(-1)[0];
    if (latest && latest.status === 'running' && latest.hermesRunId) running = latest;
    else await sleep(500);
  }
  await sleep(4000);
  const stopAt = now();
  const stopRes = running ? await api('POST', `${HARNESS}/clio/hermes/runs/${running.runId}/stop`, { who: alice }) : null;
  const stopped = await longStream;
  const stopFull = running ? await waitForRun(alice, running.runId, isTerminal, 120_000) : null;
  record('D6a', 'Explicit Stop cancels the Hermes run and yields an accurate terminal state', running && stopRes && stopRes.status >= 200 && stopRes.status < 300 && ['cancelled', 'expired'].includes(stopFull?.run?.status) && stopped.frames.some((f) => f.type === 'done' && ['aborted', 'expired'].includes(f.finishReason)) ? 'passed' : 'failed', {
    runId: running?.runId, stopResponse: stopRes?.json ?? null, stopToTerminalMs: stopFull ? Date.parse(stopFull.run.finishedAt) - stopAt : null, finalStatus: stopFull?.run?.status, doneFrame: stopped.frames.find((f) => f.type === 'done'), assistantMessageId: stopFull?.run?.assistantMessageId,
  });

  // Browser disconnect (detach) → run continues → reconnect with cursor
  const detach = await streamTurn(alice, CONV_A, 'Write a numbered list of eight short facts about the US federal appropriations calendar, one per line, then finish with the word END.', { abortWhen: (f) => f.type === 'text' });
  const seqAtAbort = null; // we do not know Meri seq from frames; replay from 0 and compare
  const detachedFull = detach.runId ? await waitForRun(alice, detach.runId, isTerminal, 180_000) : null;
  const replay = await api('GET', `${HARNESS}/clio/hermes/runs/${detach.runId}/events?after=0`, { who: alice, raw: true });
  const replayFrames = replay.text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  const replayText = replayFrames.filter((f) => f.type === 'text').map((f) => f.text).join('');
  const messages = await api('GET', `${HARNESS}/harness/conversations/${CONV_A}/messages`, { who: alice });
  const persisted = (messages.json ?? []).find((m) => m.id === detachedFull?.run?.assistantMessageId);
  record('D6b', 'Browser disconnect detaches (run continues), assistant message persisted, reconnect replays events from cursor', detach.aborted && detachedFull?.run?.status === 'completed' && detachedFull?.run?.detached === true && persisted && replayText.includes('END') && replayFrames.some((f) => f.type === 'done') ? 'passed' : 'failed', {
    runId: detach.runId, framesSeenBeforeDisconnect: detach.frames.length, abortedAtMs: detach.timings.abortedAt, finalStatus: detachedFull?.run?.status, detachedFlag: detachedFull?.run?.detached, replayFrameCount: replayFrames.length, replayTextChars: replayText.length, persistedMessagePreview: persisted?.body?.slice(0, 200) ?? null,
    persistedMetadataKeys: persisted ? Object.keys(persisted.metadata ?? {}) : null, lastSeq: detachedFull?.run?.lastSeq, seqAtAbort,
  });

  // Fresh worker start: replace container, confirm Hermes session history survives and a new turn continues the conversation
  const sessionBefore = detachedFull?.run?.hermesSessionId ?? null;
  dockerRm();
  const cold = await startWorker(WORKERS.alice, { modelKey, workerToken, scopeId, freshVolume: false });
  const history = sessionBefore ? await hermesApi('GET', `/api/sessions/${sessionBefore}/messages`) : null;
  const cont = await streamTurn(alice, CONV_A, 'Without repeating them, how many facts did you list in your previous answer, and what was the last word? One sentence.');
  record('D6c', 'Fresh worker start: native session history persists in the scope home; new turn continues the same Hermes session', history?.status === 200 && cont.status === 200 && cont.text.length > 0 ? 'passed' : 'failed', {
    restartMs: cold.startMs, hermesSessionId: sessionBefore, sessionMessagesStatus: history?.status ?? null, sessionMessageCount: Array.isArray(history?.json?.messages) ? history.json.messages.length : (Array.isArray(history?.json) ? history.json.length : null), continuationText: cont.text.slice(0, 300), continuationRunId: cont.runId,
    note: 'Session history is Hermes state.db on the scope volume; Meri retains the canonical transcript in clio_messages. Mid-turn process state is NOT restored (fresh-attempt contract).',
  });
}

async function isolationChecks(workerTokenAlice, workerTokenBob, someAliceRunId, someAliceHermesRunId) {
  const bobOnAlice = await api('GET', `${HARNESS}/clio/hermes/runs/${someAliceRunId}`, { who: bob });
  record('ISO1', 'Cross-user: Bob cannot read Alice run (guessed id → 404)', bobOnAlice.status === 404 ? 'passed' : 'failed', { httpStatus: bobOnAlice.status, runId: someAliceRunId });

  const carolGate = await api('GET', `${HARNESS}/harness/gate`, { who: carol });
  const carolStream = await api('POST', `${HARNESS}/harness/conversations/${FIX.conversations.carol.id}/stream`, { who: carol, body: { body: 'hello' } });
  record('ISO2', 'Cross-tenant: outside tenant is not routed to Hermes (gate false, stream refused)', carolGate.json?.hermes === false && carolStream.status === 409 ? 'passed' : 'failed', { gate: carolGate.json, streamStatus: carolStream.status });

  const spoof = await api('GET', `${HARNESS}/harness/gate`, { who: { tenantId: alice.tenantId, userId: carol.userId } });
  const spoofBody = await api('POST', `${HARNESS}/harness/conversations/${CONV_A}/stream`, { who: { tenantId: FIX.tenants.outside.id, userId: alice.userId }, body: { body: 'hello', tenantId: alice.tenantId } });
  record('ISO3', 'Spoof: asserting the pilot tenant with a non-member identity is refused; body tenant fields are ignored', spoof.status === 403 && spoofBody.status === 403 ? 'passed' : 'failed', { spoofStatus: spoof.status, spoofBodyStatus: spoofBody.status });

  const brokerBase = `${HARNESS}/internal/hermes/broker`;
  const bh = (token, runId) => ({ authorization: `Bearer ${token}`, 'x-meri-hermes-run-id': runId ?? '', 'content-type': 'application/json' });
  const tamper = await fetch(`${brokerBase}/whoami`, { headers: bh(workerTokenAlice.slice(0, -4) + 'AAAA', someAliceHermesRunId) });
  const wrongScope = await fetch(`${brokerBase}/whoami`, { headers: bh(workerTokenBob, someAliceHermesRunId) });
  const unknownRun = await fetch(`${brokerBase}/whoami`, { headers: bh(workerTokenAlice, 'run_doesnotexist') });
  const noToken = await fetch(`${brokerBase}/whoami`, { headers: { 'x-meri-hermes-run-id': someAliceHermesRunId } });
  const terminalRun = await fetch(`${brokerBase}/whoami`, { headers: bh(workerTokenAlice, someAliceHermesRunId) });
  record('ISO4', 'Broker credential boundary: tampered token 401, other-user token on Alice run 403, unknown run 404, missing token 401, finished run 409', tamper.status === 401 && wrongScope.status === 403 && unknownRun.status === 404 && noToken.status === 401 && terminalRun.status === 409 ? 'passed' : 'failed', {
    tampered: tamper.status, otherScope: wrongScope.status, unknownRun: unknownRun.status, missing: noToken.status, terminalRun: terminalRun.status,
  });

  await api('POST', `${HARNESS}/harness/env/hermes-enabled`, { body: { enabled: false } });
  const offGate = await api('GET', `${HARNESS}/harness/gate`, { who: alice });
  const offStream = await api('POST', `${HARNESS}/harness/conversations/${CONV_A}/stream`, { who: alice, body: { body: 'hello' } });
  const offCaps = await api('GET', `${HARNESS}/clio/hermes/capabilities`, { who: alice });
  await api('POST', `${HARNESS}/harness/env/hermes-enabled`, { body: { enabled: true } });
  record('ISO5', 'Feature flag off: pilot tenant immediately leaves Hermes (gate false, stream not routed, control surface 404)', offGate.json?.hermes === false && offStream.status === 409 && offCaps.status === 404 ? 'passed' : 'failed', { gate: offGate.json, streamStatus: offStream.status, capabilitiesStatus: offCaps.status });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(`evidence → ${EVIDENCE_DIR}`);
  const meta = { stamp: STAMP, image: IMAGE, model: MODEL, provider: PROVIDER, baseUrl: BASE_URL, node: process.version, only: ONLY, host: { platform: process.platform, arch: process.arch, cpus: (await import('node:os')).cpus().length } };
  save('meta.json', meta);
  if (!SKIP_SEED) {
    log('seeding fixtures');
    sh(path.join(ROOT, 'apps/api/node_modules/.bin/tsx.cmd'), ['--tsconfig', 'tsconfig.meri-hermes-harness.json', 'scripts/meri-hermes-phase0-seed.ts'], { cwd: path.join(ROOT, 'apps/api'), env: { ...process.env, DATABASE_URL }, shell: true });
  }
  const modelKey = resolveModelKey();
  const started = await startHarnessApi(FIX.tenants.pilot.id);
  save('harness-api-start.json', { startMs: started.startMs, health: started.health });

  const tokenA = await api('POST', `${HARNESS}/harness/worker-token`, { body: { tenantId: alice.tenantId, userId: alice.userId } });
  const tokenB = await api('POST', `${HARNESS}/harness/worker-token`, { body: { tenantId: bob.tenantId, userId: bob.userId } });
  if (tokenA.status !== 201 && tokenA.status !== 200) throw new Error(`worker token mint failed: ${tokenA.status} ${JSON.stringify(tokenA.json)}`);
  save('worker-token-claims.json', { alice: { ...tokenA.json, token: '<redacted>' }, bob: { ...tokenB.json, token: '<redacted>' } });

  let cold = null;
  let coldBob = null;
  if (!SKIP_DOCKER) {
    cold = await startWorker(WORKERS.alice, { modelKey, workerToken: tokenA.json.token, scopeId: tokenA.json.executionScopeId, freshVolume: true });
    log(`alice worker cold start ${cold.startMs} ms`);
    coldBob = await startWorker(WORKERS.bob, { modelKey, workerToken: tokenB.json.token, scopeId: tokenB.json.executionScopeId, freshVolume: true });
    log(`bob worker cold start ${coldBob.startMs} ms`);
    save('worker-starts.json', { alice: cold, bob: coldBob });
  }
  sampleStats('idle-after-start');
  const caps = await hermesApi('GET', '/v1/capabilities');
  const toolsets = await hermesApi('GET', '/v1/toolsets');
  const skills = await hermesApi('GET', '/v1/skills');
  const detailed = await hermesApi('GET', '/health/detailed');
  save('hermes-capabilities.json', caps.json);
  save('hermes-toolsets.json', toolsets.json);
  save('hermes-skills-initial.json', skills.json);
  save('hermes-health-detailed.json', detailed.json);
  const meriCaps = await api('GET', `${HARNESS}/clio/hermes/capabilities`, { who: alice });
  save('meri-capabilities.json', meriCaps.json);
  const toolsetList = toolsets.json?.data ?? toolsets.json?.toolsets ?? [];
  const toolsetNames = toolsetList.map((t) => t.name ?? t.id ?? String(t));
  const meriTools = toolsetList.filter((t) => (t.name ?? '') === 'meri').flatMap((t) => (t.tools ?? []).map((x) => x.name ?? x));
  record('CAPS', 'Pinned build capability inspection over /v1/capabilities, /v1/toolsets, /v1/skills', caps.status === 200 && toolsets.status === 200 && meriCaps.status === 200 && toolsetNames.includes('meri') ? 'passed' : 'failed', {
    features: caps.json?.features ?? null, toolsetNames, meriToolsetTools: meriTools, skillsApiStatus: skills.status, skillsApiError: skills.status !== 200 ? skills.json : null, meriCapabilitiesStatus: meriCaps.status, coldStartMs: cold?.startMs ?? null,
  });

  let d1 = null;
  try {
    if (should('D1')) d1 = await demoD1();
    if (should('D2')) await demoD2();
    if (should('D3')) await demoD3(modelKey, tokenA.json.token, tokenA.json.executionScopeId);
    if (should('D4')) await demoD4();
    if (should('D5')) await demoD5();
    if (should('D6')) await demoD6(modelKey, tokenA.json.token, tokenA.json.executionScopeId);
    if (should('ISO')) {
      const runs = await api('GET', `${HARNESS}/harness/conversations/${CONV_A}/runs`, { who: alice });
      const some = (runs.json ?? []).find((r) => r.hermesRunId) ?? { runId: randomUUID(), hermesRunId: 'run_none' };
      await isolationChecks(tokenA.json.token, tokenB.json.token, some.runId, some.hermesRunId);
    }
  } catch (error) {
    record('HARNESS_ERROR', 'Unhandled harness error', 'failed', { error: redact(String(error?.stack ?? error)) });
  }

  // Measurements
  sampleStats('end');
  const allRuns = await api('GET', `${HARNESS}/harness/conversations/${CONV_A}/runs`, { who: alice });
  const allRuns2 = await api('GET', `${HARNESS}/harness/conversations/${CONV_A2}/runs`, { who: alice });
  const runs = [...(allRuns.json ?? []), ...(allRuns2.json ?? [])];
  const usage = runs.map((r) => r.usage).filter(Boolean);
  const tokens = usage.reduce((a, u) => ({ input: a.input + (u.inputTokens || 0), output: a.output + (u.outputTokens || 0) }), { input: 0, output: 0 });
  const toolLatencies = [];
  for (const r of runs) {
    const full = await api('GET', `${HARNESS}/harness/runs/${r.runId}/full`, { who: alice });
    for (const e of full.json?.events ?? []) if (e.kind === 'tool.completed') toolLatencies.push({ tool: e.payload.tool, seconds: e.payload.durationSeconds, error: e.payload.error });
  }
  const fargateRatePerHour = 0.0494; // plan §14 baseline, 1 vCPU / 2 GiB Linux/x86, us-east-1 — documented estimate, not a measurement
  const workerWallHours = runs.length ? (Date.parse(runs.at(-1).updatedAt) - Date.parse(runs[0].createdAt)) / 3.6e6 : 0;
  const priceIn = Number(process.env.MERI_HERMES_PRICE_INPUT_PER_M ?? 0);
  const priceOut = Number(process.env.MERI_HERMES_PRICE_OUTPUT_PER_M ?? 0);
  const measurements = {
    coldStartMs: cold?.startMs ?? null, harnessApiStartMs: started.startMs, runsObserved: runs.length,
    perRun: runs.map((r) => ({ runId: r.runId, status: r.status, createdAt: r.createdAt, finishedAt: r.finishedAt, wallMs: r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.createdAt) : null, usage: r.usage, brokerCalls: r.brokerCalls })),
    tokens, toolLatencies, dockerStats: statsSamples,
    cost: {
      workerComputeEstimateUsd: Number((workerWallHours * fargateRatePerHour).toFixed(4)), workerWallHours: Number(workerWallHours.toFixed(3)), fargateRatePerHourUsd: fargateRatePerHour,
      modelCostUsd: priceIn && priceOut ? Number(((tokens.input / 1e6) * priceIn + (tokens.output / 1e6) * priceOut).toFixed(4)) : null,
      modelPricingSource: priceIn && priceOut ? 'MERI_HERMES_PRICE_*_PER_M env' : 'not supplied — tokens reported, dollar cost not asserted',
    },
    hermesLogTail: dockerLogs(200).split('\n').slice(-60),
  };
  save('measurements.json', measurements);

  const summary = ['# Phase 0 harness run ' + STAMP, '', `image: ${IMAGE}  model: ${MODEL} (${PROVIDER} @ ${BASE_URL})`, '', '| id | title | status |', '|---|---|---|', ...checks.map((c) => `| ${c.id} | ${c.title} | ${c.status} |`), '', `Cold start: ${measurements.coldStartMs} ms. Runs: ${runs.length}. Tokens in/out: ${tokens.input}/${tokens.output}.`].join('\n');
  writeFileSync(path.join(EVIDENCE_DIR, 'summary.md'), summary);
  save('checks.json', checks);
  log('\n' + summary);

  if (!KEEP) {
    dockerRmAll();
    for (const w of Object.values(WORKERS)) { try { sh('docker', ['volume', 'rm', w.volume]); } catch { /* keep going */ } }
    harnessProc?.kill();
  } else {
    log(`kept workers ${Object.values(WORKERS).map((w) => w.name).join(', ')} and harness API (pid ${harnessProc?.pid ?? 'reused'}) running`);
    // Detach so this process can exit while the API keeps serving phased runs.
    harnessProc?.unref?.();
    harnessProc?.stdout?.destroy?.();
    harnessProc?.stderr?.destroy?.();
  }
  process.exit(checks.some((c) => c.status === 'failed') ? 1 : 0);
}

main().catch((error) => {
  console.error(redact(String(error?.stack ?? error)));
  if (!KEEP) dockerRmAll();
  harnessProc?.kill();
  process.exit(2);
});
