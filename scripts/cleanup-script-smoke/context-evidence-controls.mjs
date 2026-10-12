/**
 * CleanUp1 §6.2 — integrated CANONICAL-CONTEXT controls.
 *
 * These exercise ACTUAL production helpers (never an imitation):
 *   - the ONE canonical `planInvocationContexts` (context derivation) over the
 *     CURRENT repository source: multi-cwd subjects keep DISTINCT contexts and the
 *     contextKey set is collision-free;
 *   - the REAL `smokeOneContext` invalid-context branch: an unknown/invalid cwd is
 *     an EXPLICIT failed obligation (never a throw, never a silently-omitted
 *     subject) that carries no fabricated invocation records;
 *   - the REAL `rawLogFor` raw-log builder: a partially/never-recorded obligation
 *     still yields a crash-safe log (the previous `undefined.containerName`
 *     TypeError is gone).
 *
 * SCOPE HONESTY: these are OWNED SYNTHETIC / source-derived controls. They are not
 * native acceptance and do not substitute for the remote native run. The runtime
 * evidence suite additionally executes the full two-cwd, six-invocation Docker-seam
 * producer/verifier roundtrip; this module covers planner, invalid-context, raw-log
 * and individual-context seam behavior.
 *
 * Usage:
 *   node scripts/cleanup-script-smoke/context-evidence-controls.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planInvocationContexts, nativeCwdFor } from './invocation-context.mjs';
import { smokeOneContext, rawLogFor } from './run-smoke.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

/** Run the integrated canonical-context controls and return `{name, ok, detail}` rows. */
export function contextEvidenceChecks() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  // ---- canonical multi-cwd planning (real planner) -------------------------
  let plan = null;
  try {
    plan = planInvocationContexts(REPO_ROOT);
  } catch (err) {
    add('context-plan: the canonical context plan derives from CURRENT source', false, `planner threw: ${err.message}`);
  }
  if (plan) {
    const contexts = Array.isArray(plan.contexts) ? plan.contexts : [];
    add('context-plan: the canonical context plan is non-empty', contexts.length > 0, `contexts=${contexts.length}`);
    const keys = contexts.map((c) => c && c.contextKey);
    add('context-plan: contextKeys are collision-free (no duplicate context/mode identity)',
      keys.length === new Set(keys).size, `unique=${new Set(keys).size}/${keys.length}`);
    // At least one physical subject carries more than one distinct cwd obligation.
    const byRel = new Map();
    for (const c of contexts) {
      if (!c || typeof c.rel !== 'string') continue;
      if (!byRel.has(c.rel)) byRel.set(c.rel, new Set());
      byRel.get(c.rel).add(c.cwdRel);
    }
    const multi = [...byRel.entries()].filter(([, s]) => s.size > 1);
    add('context-plan: a subject with two distinct cwd obligations keeps DISTINCT contexts',
      multi.length > 0, `multi-cwd subjects=${multi.length}`);
  }

  // ---- REAL smokeOneContext invalid-context branch (no container) ----------
  try {
    const entry = { rel: 'scripts/definitely-not-tracked.mjs', subject: 'root/scripts', kind: 'entrypoint', destructive: [] };
    const ctx = {
      contextKey: 'invctx::scripts/definitely-not-tracked.mjs::unknown-cwd', rel: 'scripts/definitely-not-tracked.mjs',
      cwdRel: 'apps/does-not-exist', kind: 'entrypoint', declarationRefs: [], declarations: [], manifestInputs: [],
      fingerprint: null, valid: false, problems: ['unknown-cwd'],
    };
    const res = smokeOneContext(REPO_ROOT, entry, ctx, 1000, 'owned-audit-image-unused', tmpdir(), null, null, 0);
    add('invalid-context: an invalid/unknown cwd is an EXPLICIT failed obligation (no throw)',
      res && res.status === 'context-invalid' && res.invalidContext === true && Array.isArray(res.reasons) && res.reasons.length > 0,
      JSON.stringify({ status: res && res.status, invalidContext: res && res.invalidContext }));
    add('invalid-context: a failed context carries NO fabricated invocation records',
      res && res.invocations && Object.keys(res.invocations).length === 0,
      JSON.stringify({ invocations: res && res.invocations }));
  } catch (err) {
    add('invalid-context: an invalid/unknown cwd is an EXPLICIT failed obligation (no throw)', false, `threw: ${err.message}`);
  }

  // ---- REAL rawLogFor crash-safety (partially / never recorded) ------------
  try {
    const t1 = rawLogFor('scripts/x.mjs', undefined, undefined, undefined);
    add('raw-log: a never-recorded obligation yields a crash-safe raw log',
      typeof t1 === 'string' && t1.includes('container=none') && t1.includes('### no-args'),
      String(t1).slice(0, 80));
    const t2 = rawLogFor('scripts/x.mjs', { args: [], exit: 2, signal: null, timedOut: false, out: 'usage\n', err: '', attempts: { network: [], write: [], permittedWrites: [] } }, undefined, undefined);
    add('raw-log: a partially-recorded obligation still renders every mode safely',
      typeof t2 === 'string' && t2.includes('### --help') && t2.includes('exit=null'),
      String(t2).slice(0, 200));
  } catch (err) {
    add('raw-log: a never-recorded obligation yields a crash-safe raw log', false, `threw: ${err.message}`);
  }

  // ---- INTEGRATED injected-Docker-seam control: ACTUAL smokeOneContext --------
  // Drives the REAL `smokeOneContext` → REAL `runWithAttemptAudit` → REAL
  // `runIsolated` through the owned `_inject.spawn` seam (no daemon contacted) with
  // a REAL pre-written strace exec in the owned evidence dir and the REAL producer
  // receipt writer targeting an owned receipts dir. ONE physical non-TS entrypoint
  // runs its ONE canonical context's three exact smoke modes; the owned identities
  // (containerId, prestart, final, trace per mode) MUST be distinct across modes and
  // the durable receipts/traces MUST actually exist on disk. Honest synthetic Docker
  // command responses only — NO native qualification is claimed.
  try {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-ctx-seam-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@probe/root', scripts: { run: 'node scripts/tool.mjs' } }));
    // A documented no-args usage branch (exit 2) and NO --help handler — the
    // smallest contract the smoke classifier accepts as `ok`.
    writeFileSync(join(root, 'scripts', 'tool.mjs'),
      "const args = process.argv.slice(2);\nif (args.length === 0) { console.error('usage: tool'); process.exit(2); }\n");

    const plan = planInvocationContexts(root);
    const entry = { rel: 'scripts/tool.mjs', subject: 'root/scripts', kind: 'entrypoint', destructive: [] };
    const ctx = plan.contexts.find((c) => c.rel === 'scripts/tool.mjs' && c.valid);
    if (!ctx) {
      add('integrated-seam: the synthetic entrypoint yields a canonical valid context', false, 'no canonical context derived from the synthetic repo');
    } else {
      const expectedNativeCwd = nativeCwdFor(ctx.cwdRel, { mountedVolume: true, nativeRoot: root });
      const nativeSubject = '/src/scripts/tool.mjs';
      const ev = mkdtempSync(join(tmpdir(), 'cleanup-ctx-seam-ev-'));
      const MODES = { noargs: [], help: ['--help'], unknown: ['--cleanup-smoke-unknown-flag'] };
      for (const [mode, args] of Object.entries(MODES)) {
        const toks = ['node', nativeSubject, ...args];
        writeFileSync(join(ev, `ctx0.${mode}.trace`), `1234  execve("/usr/local/bin/node", [${toks.map((t) => `"${t}"`).join(', ')}], 0x0) = 0\n`);
      }

      // Honest synthetic Docker command responses (no daemon contacted). `create`
      // records the exact id + run label; `inspect` proves ownership / WorkingDir /
      // post-rm absence; the rest are finite successful transports.
      let label = '';
      const spawnFn = (cmd, args = []) => {
        if (cmd !== 'docker') return { status: 1, stdout: '', stderr: '' };
        const sub = args[0];
        if (sub === 'create') {
          const hit = args.find((x) => String(x).startsWith('cleanup-smoke.run='));
          if (hit) label = String(hit).slice('cleanup-smoke.run='.length);
          // A DISTINCT, per-invocation id derived from the owned run label so the
          // three modes never share a container identity.
          const id = createHash('sha256').update(`cid|${label}`).digest('hex');
          const ci = args.indexOf('--cidfile');
          if (ci >= 0) { try { writeFileSync(args[ci + 1], id); } catch { /* ignore */ } }
          return { status: 0, stdout: '', stderr: '' };
        }
        if (sub === 'inspect') {
          const fmt = args[2] ?? '';
          const id = args[args.length - 1];
          if (/Labels/.test(fmt)) return { status: 0, stdout: `${id}|${label}`, stderr: '' };
          if (/WorkingDir/.test(fmt)) return { status: 0, stdout: JSON.stringify(expectedNativeCwd), stderr: '' };
          return { status: 1, stdout: '', stderr: `Error: No such container: ${id}` };
        }
        if (sub === 'start' || sub === 'rm') return { status: 0, stdout: '', stderr: '' };
        if (sub === 'wait') return { status: 0, stdout: '2', stderr: '' };
        if (sub === 'logs') return { status: 0, stdout: 'usage: tool\n', stderr: '' };
        return { status: 1, stdout: '', stderr: '' };
      };

      // Owned durable receipt directory: the ACTUAL producer writes its immutable
      // prestart/final receipts here (real files, never suppressed claims). The prior
      // env value is restored immediately after the control.
      const receiptsDir = join(root, 'owned-receipts');
      mkdirSync(receiptsDir, { recursive: true });
      const prevReceipts = process.env.CLEANUP_SMOKE_RECEIPTS;
      process.env.CLEANUP_SMOKE_RECEIPTS = receiptsDir;
      let res;
      try {
        res = smokeOneContext(root, entry, ctx, 5000, 'owned-audit-image-unused', ev, null, { volume: 'v', completed: true, verifiedLabel: true }, 0, { spawn: spawnFn });
      } finally {
        if (prevReceipts === undefined) delete process.env.CLEANUP_SMOKE_RECEIPTS;
        else process.env.CLEANUP_SMOKE_RECEIPTS = prevReceipts;
      }
      const invs = res.invocations ?? {};
      const modes = ['noArgs', 'help', 'unknown'];
      add('integrated-seam: the ACTUAL smokeOneContext (through runWithAttemptAudit + runIsolated) executes the entrypoint ok',
        res.status === 'ok' && modes.every((m) => invs[m] && invs[m].entrypointExecuted === true),
        JSON.stringify({ status: res.status, executed: modes.map((m) => invs[m] && invs[m].entrypointExecuted) }));
      const cids = modes.map((m) => invs[m] && invs[m].containerId);
      add('integrated-seam: the three modes own DISTINCT real returned container ids',
        new Set(cids).size === 3 && cids.every((c) => typeof c === 'string' && /^[0-9a-f]{64}$/.test(c)),
        JSON.stringify(cids));
      const rawPaths = [];
      for (const m of modes) rawPaths.push(invs[m] && invs[m].prestartReceiptPath, invs[m] && invs[m].finalReceiptPath, invs[m] && invs[m].tracePath);
      add('integrated-seam: the nine owned raw files (prestart/final/trace per mode) are DISTINCT',
        rawPaths.every((p) => typeof p === 'string' && p.length > 0) && new Set(rawPaths).size === 9,
        JSON.stringify(rawPaths));
      // The owned raw files ACTUALLY exist on disk (durable receipts + traces), are
      // non-empty, and the FIRST context's files are retained.
      const firstPaths = [invs.noArgs && invs.noArgs.prestartReceiptPath, invs.noArgs && invs.noArgs.finalReceiptPath, invs.noArgs && invs.noArgs.tracePath];
      add('integrated-seam: the first context\'s owned raw files exist, are non-empty and are retained',
        firstPaths.every((p) => typeof p === 'string' && existsSync(p) && statSync(p).size > 0),
        JSON.stringify(firstPaths.map((p) => (typeof p === 'string' ? { p, exists: existsSync(p), size: (() => { try { return statSync(p).size; } catch { return null; } })() } : p))));
    }
  } catch (err) {
    add('integrated-seam: the ACTUAL smokeOneContext (through runWithAttemptAudit + runIsolated) executes the entrypoint ok', false, `threw: ${err.message}`);
  }

  return checks;
}

if (process.argv[1]?.endsWith('context-evidence-controls.mjs')) {
  const checks = contextEvidenceChecks();
  const failed = checks.filter((c) => !c.ok);
  const r = { module: 'context-evidence-controls', checks, passed: checks.length - failed.length, total: checks.length, ok: failed.length === 0 };
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
