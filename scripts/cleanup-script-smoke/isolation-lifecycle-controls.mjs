/**
 * CleanUp1 §6.2 — lifecycle POLICY controls for the isolated runner.
 *
 * These are executable controls (root runs them; no Docker is touched here) that
 * import the ACTUAL `isolation.mjs` and drive the container lifecycle policies
 * through the module's test-only `_inject` seam:
 *
 *   - a failed `docker create` WITHOUT a readable cidfile is UNKNOWN — never
 *     "not-created:true";
 *   - a failed `docker create` WITH a valid durable id NEVER starts: the
 *     immutable prestart receipt is retained and the exact owned id is removed;
 *   - a prestart-receipt write failure fails closed: the exact id is removed and
 *     the container is never started;
 *   - a failed `docker start` is a fail-closed setup condition;
 *   - removal proof: exact-id-bound definite absence ⇒ removed; a wrong id, a
 *     wrong ownership label, a nonzero `rm`, a daemon/unknown inspect and a
 *     GENERIC (non-exact-id) "no such" diagnostic each fail closed. Root round 32
 *     additionally requires a SINGLE, fully-anchored diagnostic for the EXACT
 *     64-hex id, so a diagnostic that only MENTIONS the id elsewhere, names
 *     ANOTHER full id, carries SUFFIX text, contains MULTIPLE diagnostics, or is
 *     a transport error is UNKNOWN — never proven absence.
 *
 * Round 46 additionally imports the PRODUCTION `runIsolated` AND `classifyRun`
 * (the run-smoke classifier) to prove the timeout/setup distinction on the REAL
 * result-to-status path:
 *   - a DEFINITE wait deadline (ETIMEDOUT) is classified as a failing `timeout`,
 *     NOT `setup-incompatibility`;
 *   - a non-timeout wait TRANSPORT error (ENOENT) fails closed as
 *     `setup-incompatibility`, never a timeout;
 *   - a missing-tool log WITH a deadline, a failed `docker logs` WITH a deadline
 *     and a failed `docker start` WITH a deadline each STILL fail closed as
 *     `setup-incompatibility` (the deadline must not mask the real setup defect);
 *   - an UNKNOWN cleanup WITH a deadline stays a fail-closed `container-residual`
 *     (removal is never assumed because the deadline fired).
 *
 * Each control is a real assertion; the runner exits non-zero iff any control
 * fails. The seam is pure (in-memory spawn outcomes), so no container is created,
 * started or removed by running this file.
 *
 * Usage:
 *   node scripts/cleanup-script-smoke/isolation-lifecycle-controls.mjs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeOwnedContainerById, runIsolated } from './isolation.mjs';
import { classifyRun } from './run-smoke.mjs';
import { discoverEntrypoints } from './discover.mjs';
import {
  planInvocationContexts,
  deriveCanonicalContexts,
  matchInvocationContext,
  nativeCwdFor,
  SMOKE_MODES,
} from './invocation-context.mjs';

const CID = 'a'.repeat(64);
const WRONG_CID = 'b'.repeat(64);

const res = (status, stdout = '', stderr = '', error = undefined, signal = null) => ({ status, stdout, stderr, error, signal });

/**
 * Build a fake docker spawn. It records the ordered subcommands it saw, writes
 * the cidfile on `create`, echoes the invocation's own ownership label back on
 * the ownership inspect, and takes a configurable removal outcome.
 */
function fakeSpawn(cfg = {}) {
  const calls = [];
  const fullCalls = [];
  let capturedLabel = cfg.ownerLabel ?? 'run-1';
  const spawn = (cmd, args = [], opts = {}) => {
    calls.push(args[0]);
    fullCalls.push({ cmd, args: args.slice(), opts: { ...opts } });
    if (cmd !== 'docker') return res(1);
    const sub = args[0];
    if (sub === 'create') {
      const ci = args.indexOf('--cidfile');
      if (ci >= 0 && cfg.cid) { try { writeFileSync(args[ci + 1], cfg.cid); } catch { /* ignore */ } }
      const hit = args.find((x) => String(x).startsWith('cleanup-smoke.run='));
      if (hit) capturedLabel = String(hit).slice('cleanup-smoke.run='.length);
      return res(cfg.createStatus ?? 0, '', cfg.createStderr ?? '');
    }
    if (sub === 'start') return res(cfg.startStatus ?? 0, '', cfg.startStderr ?? '');
    if (sub === 'wait') {
      // A DEFINITE wait deadline: the CLI was killed by its own `docker wait`
      // timeout (spawnSync surfaces `error.code === 'ETIMEDOUT'`).
      if (cfg.waitTimeout) return res(null, '', '', { code: 'ETIMEDOUT' });
      // A RAW wait outcome (exact status/stdout/stderr and an optional spawn
      // `error`) for the non-timeout transport-error control.
      if (cfg.waitRaw) return res(Object.hasOwn(cfg.waitRaw, 'status') ? cfg.waitRaw.status : null, cfg.waitRaw.stdout ?? '', cfg.waitRaw.stderr ?? '', cfg.waitRaw.error, cfg.waitRaw.signal ?? null);
      return res(cfg.waitStatus ?? 0, cfg.waitStdout ?? '0', cfg.waitStderr ?? '');
    }
    if (sub === 'logs') return res(cfg.logsStatus ?? 0, cfg.logsStdout ?? '', cfg.logsStderr ?? '');
    if (sub === 'inspect') {
      const fmt = args[2] ?? '';
      const id = args[args.length - 1];
      if (/Labels/.test(fmt)) {
        if (cfg.ownerInspect === 'fail') return res(1, '', 'Error response from daemon: Cannot connect to the Docker daemon');
        if (cfg.ownerId !== undefined) return res(0, `${cfg.ownerId}|${cfg.ownerLabel ?? capturedLabel}`, '');
        return res(0, `${id}|${cfg.ownerLabel ?? capturedLabel}`, '');
      }
      if (/WorkingDir/.test(fmt)) {
        if (cfg.workingDirInspect === 'fail') return res(1, '', 'Error response from daemon: Cannot connect to the Docker daemon');
        if (cfg.workingDirInspect === 'malformed') return res(0, 'not-json', '');
        // An EXACT raw stdout/stderr (and optional transport status/signal/error)
        // for the lossless-inspection controls — additive; the default branch below
        // is unchanged for every existing control.
        if (cfg.workingDirRaw !== undefined) {
          return res(cfg.workingDirStatus ?? 0, cfg.workingDirRaw, cfg.workingDirStderr ?? '', cfg.workingDirError, cfg.workingDirSignal ?? null);
        }
        return res(0, JSON.stringify(cfg.workingDir ?? '/src'), '');
      }
      if (cfg.afterRm === 'present') return res(0, id, '');
      if (cfg.afterRm === 'absent-generic') return res(1, '', 'Error: No such container: deadbeefdeadbeef');
      if (cfg.afterRm === 'unknown') return res(1, '', 'Error response from daemon: timeout waiting for container');
      // A raw after-rm outcome (exact status/stdout/stderr, and an optional
      // spawn `error`) for the round-32 absence-binding controls.
      if (cfg.afterRmRaw) return res(Object.hasOwn(cfg.afterRmRaw, 'status') ? cfg.afterRmRaw.status : 1, cfg.afterRmRaw.stdout ?? '', cfg.afterRmRaw.stderr ?? '', cfg.afterRmRaw.error, cfg.afterRmRaw.signal ?? null);
      // default: exact-id-bound definite absence
      return res(1, '', `Error: No such container: ${id}`);
    }
    if (sub === 'rm') return res(cfg.rmStatus ?? 0, '', cfg.rmStderr ?? '');
    return res(1);
  };
  spawn.calls = calls;
  spawn.fullCalls = fullCalls;
  return spawn;
}

/**
 * An OWNED disposable fixture repo containing an `apps/api/scripts/*.ts` subject
 * (and, by default, a committed `apps/api/tsconfig.json`). Used to drive the
 * committed-tsconfig SELECTION through the REAL `runIsolated` against real bytes.
 */
function fixtureRepo(prefix, { withConfig = true, compilerOptions = { experimentalDecorators: true, emitDecoratorMetadata: true } } = {}) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(repo, 'apps', 'api', 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'apps', 'api', 'scripts', 'probe.ts'), 'export const x = 1;\n');
  if (withConfig) writeFileSync(join(repo, 'apps', 'api', 'tsconfig.json'), JSON.stringify({ compilerOptions }));
  return repo;
}

/**
 * An OWNED fixture whose physical CLI is declared from SEVERAL invocation
 * contexts (root package, `cd`, pnpm `--filter`, package-local) plus a `--commit`
 * flag, and whose TS subject is declared from both the root cwd and the apps/api
 * cwd. Used to drive the ACTUAL planner + `runIsolated` through `_inject`.
 */
function contextFixture(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(repo, 'apps', 'api', 'scripts'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: '@probe/root', scripts: {
      root: 'node apps/api/scripts/tool.mjs',
      cd: 'cd apps/api && node scripts/tool.mjs',
      filter: 'pnpm --filter @probe/api exec node scripts/tool.mjs',
      tsroot: 'tsx apps/api/scripts/probe.ts',
      commit: 'tsx apps/api/scripts/probe.ts --commit',
    } }),
  );
  writeFileSync(
    join(repo, 'apps', 'api', 'package.json'),
    JSON.stringify({ name: '@probe/api', scripts: { local: 'node scripts/tool.mjs', tslocal: 'tsx scripts/probe.ts' } }),
  );
  writeFileSync(join(repo, 'apps', 'api', 'tsconfig.json'), JSON.stringify({ compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } }));
  writeFileSync(join(repo, 'apps', 'api', 'scripts', 'tool.mjs'), 'console.error("Usage: tool <input>"); process.exit(2);\n');
  writeFileSync(join(repo, 'apps', 'api', 'scripts', 'probe.ts'), 'export const x = 1;\n');
  return repo;
}

function runControls() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  // ---- A. failed create WITHOUT a readable cidfile ⇒ UNKNOWN ---------------
  {
    const spawn = fakeSpawn({ cid: null, createStatus: 1, createStderr: 'Error: failed to create' });
    const r = runIsolated({ repoRoot: process.cwd(), rel: 'x.mjs', _inject: { spawn } });
    add(
      'failed create without cid is UNKNOWN (not not-created)',
      r.setupError === true && r.containerCreated === false && r.containerId === null && r.removalUnknown === true && r.containerResidual === true && !spawn.calls.includes('start'),
      JSON.stringify({ setupError: r.setupError, created: r.containerCreated, id: r.containerId, unknown: r.removalUnknown, residual: r.containerResidual, calls: spawn.calls }),
    );
  }

  // ---- B. failed create WITH a valid id ⇒ NEVER started, exact id removed ---
  {
    const writes = [];
    const spawn = fakeSpawn({ cid: CID, createStatus: 1, createStderr: 'Error: failed' });
    const r = runIsolated({ repoRoot: process.cwd(), rel: 'x.mjs', _inject: { spawn, writePrestart: (p, t) => writes.push({ p, t }) } });
    add(
      'failed create with valid id never starts and retains the prestart receipt',
      r.createFailed === true && r.containerStarted === false && !spawn.calls.includes('start') && !!r.prestartReceiptPath && writes.length >= 1,
      JSON.stringify({ createFailed: r.createFailed, started: r.containerStarted, started_calls: spawn.calls.filter((c) => c === 'start').length, prestart: r.prestartReceiptPath }),
    );
    add(
      'failed create with valid id removes the exact owned id (definite absence)',
      r.containerCreated === true && r.containerTerminated === true && r.containerResidual === false && r.status === null && r.setupError === true,
      JSON.stringify({ created: r.containerCreated, terminated: r.containerTerminated, residual: r.containerResidual, status: r.status }),
    );
  }

  // ---- C. prestart-receipt write failure ⇒ fail closed, never starts -------
  {
    const spawn = fakeSpawn({ cid: CID, createStatus: 0 });
    const r = runIsolated({
      repoRoot: process.cwd(), rel: 'x.mjs',
      _inject: { spawn, writePrestart: () => { throw new Error('simulated receipt write failure'); } },
    });
    add(
      'prestart receipt write failure fails closed and removes the exact id without starting',
      r.setupError === true && !!r.receiptError && r.containerTerminated === true && r.containerResidual === false && !spawn.calls.includes('start'),
      JSON.stringify({ setupError: r.setupError, receiptError: r.receiptError, terminated: r.containerTerminated, started: spawn.calls.includes('start') }),
    );
  }

  // ---- D. failed start ⇒ fail-closed setup condition ----------------------
  {
    const spawn = fakeSpawn({ cid: CID, createStatus: 0, startStatus: 1, startStderr: 'Error: start failed' });
    const r = runIsolated({ repoRoot: process.cwd(), rel: 'x.mjs', _inject: { spawn, writePrestart: () => {} } });
    add(
      'failed docker start is a fail-closed setup condition',
      r.setupError === true && spawn.calls.includes('start') && r.containerTerminated === true,
      JSON.stringify({ setupError: r.setupError, start_calls: spawn.calls.filter((c) => c === 'start').length, terminated: r.containerTerminated }),
    );
  }

  for (const [name, cfg] of [
    ['wrong label before start', { ownerLabel: 'foreign-run' }],
    ['wrong id before start', { ownerId: WRONG_CID }],
    ['unknown ownership before start', { ownerInspect: 'fail' }],
  ]) {
    const spawn = fakeSpawn({ cid: CID, ...cfg });
    const r = runIsolated({ repoRoot: process.cwd(), rel: 'x.mjs', _inject: { spawn, writePrestart: () => {} } });
    add(`${name} never starts or removes an unverified object`, r.setupError === true && !spawn.calls.includes('start') && !spawn.calls.includes('rm'), JSON.stringify({ setupError: r.setupError, calls: spawn.calls }));
  }

  // A transport error or malformed exit status cannot stand in for a subject run.
  for (const [name, cfg] of [
    ['failed wait transport', { waitStatus: 1, waitStdout: '0' }],
    ['failed log transport', { logsStatus: 1 }],
    ['malformed exit status', { waitStdout: '0garbage' }],
    ['out of range exit status', { waitStdout: '256' }],
  ]) {
    const spawn = fakeSpawn({ cid: CID, ...cfg });
    const r = runIsolated({ repoRoot: process.cwd(), rel: 'x.mjs', _inject: { spawn, writePrestart: () => {} } });
    add(`${name} fails closed and removes the owned id`, r.setupError === true && r.containerTerminated === true, JSON.stringify({ setupError: r.setupError, terminated: r.containerTerminated, status: r.status }));
  }
  {
    const spawn = fakeSpawn({ cid: CID });
    const r = runIsolated({ repoRoot: process.cwd(), rel: 'x.mjs', _inject: { spawn, writePrestart: (p) => { if (p.endsWith('.final.json')) throw new Error('final receipt failure'); } } });
    add('final receipt write failure fails closed after exact cleanup', r.setupError === true && r.finalReceiptPath === null && r.containerTerminated === true, JSON.stringify({ setupError: r.setupError, finalReceipt: r.finalReceiptPath, terminated: r.containerTerminated }));
  }
  {
    const spawn = fakeSpawn({ cid: CID });
    const r = runIsolated({ repoRoot: process.cwd(), rel: 'x.mjs', _inject: { spawn, writePrestart: () => {} } });
    add('successful lifecycle retains both receipts and exact cleanup', r.setupError === false && r.status === 0 && !!r.prestartReceiptPath && !!r.finalReceiptPath && r.containerTerminated === true, JSON.stringify({ setupError: r.setupError, status: r.status, terminated: r.containerTerminated }));
  }

  // ---- E. removal: exact-id-bound definite absence ⇒ removed ---------------
  {
    const spawn = fakeSpawn({ cid: CID, afterRm: 'absent-exact' });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add('removal is proven by exact-id-bound definite absence', removal.removed === true && removal.unknown === false, JSON.stringify(removal));
  }

  // ---- F. wrong id ⇒ id-mismatch (not removed, not "unknown") --------------
  {
    const spawn = fakeSpawn({ cid: CID, ownerId: WRONG_CID });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add('removal refuses a wrong id (id-mismatch)', removal.removed === false && removal.unknown === false && /id-mismatch/.test(removal.detail), JSON.stringify(removal));
  }

  // ---- G. wrong ownership label ⇒ ownership-mismatch ----------------------
  {
    const spawn = fakeSpawn({ cid: CID, ownerLabel: 'some-other-run' });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add('removal refuses a wrong ownership label', removal.removed === false && removal.unknown === false && /ownership-mismatch/.test(removal.detail), JSON.stringify(removal));
  }

  // ---- H. rm failure ⇒ fail closed unknown --------------------------------
  {
    const spawn = fakeSpawn({ cid: CID, rmStatus: 1, rmStderr: 'rm failed' });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add('removal fails closed on a nonzero rm', removal.removed === false && removal.unknown === true && /rm-exit-1/.test(removal.detail), JSON.stringify(removal));
  }

  // ---- I. daemon/unknown inspect ⇒ UNKNOWN (not absence) ------------------
  {
    const spawn = fakeSpawn({ cid: CID, ownerInspect: 'fail' });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add('removal treats a daemon/unknown inspect as UNKNOWN, not absence', removal.removed === false && removal.unknown === true && /inspect-failed/.test(removal.detail), JSON.stringify(removal));
  }

  // ---- J. GENERIC "no such" without the exact id ⇒ UNKNOWN (not removed) ---
  {
    const spawn = fakeSpawn({ cid: CID, afterRm: 'absent-generic' });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add(
      'removal refuses a generic non-exact-id absence diagnostic',
      removal.removed === false && removal.unknown === true && /absence-unknown/.test(removal.detail),
      JSON.stringify(removal),
    );
  }

  // ---- K. still present after rm ⇒ not removed ----------------------------
  {
    const spawn = fakeSpawn({ cid: CID, afterRm: 'present' });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add('removal reports still-present as not removed', removal.removed === false && removal.unknown === false && /still-present/.test(removal.detail), JSON.stringify(removal));
  }

  // ---- L. exact-id absence via the engine "object" noun ⇒ removed ----------
  {
    const spawn = fakeSpawn({ cid: CID, afterRmRaw: { status: 1, stderr: `Error: No such object: ${CID}` } });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add(
      'removal accepts a single exact-id "No such object" diagnostic (engine noun)',
      removal.removed === true && removal.unknown === false,
      JSON.stringify(removal),
    );
  }

  // ---- M. daemon-prefixed exact-id absence ⇒ removed ----------------------
  {
    const spawn = fakeSpawn({ cid: CID, afterRmRaw: { status: 1, stderr: `Error response from daemon: No such container: ${CID}` } });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add(
      'removal accepts a daemon-prefixed exact-id absence diagnostic',
      removal.removed === true && removal.unknown === false,
      JSON.stringify(removal),
    );
  }

  // ---- N. ANOTHER full id named ⇒ UNKNOWN ---------------------------------
  {
    const spawn = fakeSpawn({ cid: CID, afterRmRaw: { status: 1, stderr: `Error: No such object: ${WRONG_CID}` } });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add(
      'removal refuses an absence diagnostic naming ANOTHER full id',
      removal.removed === false && removal.unknown === true && /absence-unknown/.test(removal.detail),
      JSON.stringify(removal),
    );
  }

  // ---- O. exact id carrying SUFFIX text ⇒ UNKNOWN -------------------------
  {
    const spawn = fakeSpawn({ cid: CID, afterRmRaw: { status: 1, stderr: `Error: No such object: ${CID}-old` } });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add(
      'removal refuses an absence diagnostic whose id carries suffix text',
      removal.removed === false && removal.unknown === true && /absence-unknown/.test(removal.detail),
      JSON.stringify(removal),
    );
  }

  // ---- P. id MENTIONED elsewhere (not the bound token) ⇒ UNKNOWN ----------
  {
    const spawn = fakeSpawn({ cid: CID, afterRmRaw: { status: 1, stderr: `Error: No such object: deadbeefdeadbeef (looked up ${CID})` } });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add(
      'removal refuses a diagnostic that merely MENTIONS the id elsewhere',
      removal.removed === false && removal.unknown === true && /absence-unknown/.test(removal.detail),
      JSON.stringify(removal),
    );
  }

  // ---- Q. MULTIPLE diagnostics ⇒ UNKNOWN ----------------------------------
  {
    const spawn = fakeSpawn({ cid: CID, afterRmRaw: { status: 1, stderr: `Error: No such object: ${CID}\nError: No such object: ${CID}` } });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add(
      'removal refuses MORE THAN ONE absence diagnostic',
      removal.removed === false && removal.unknown === true && /absence-unknown/.test(removal.detail),
      JSON.stringify(removal),
    );
  }

  // ---- R. transport error on the absence check ⇒ UNKNOWN ------------------
  {
    // The matching stderr must NOT rescue a transport failure: a killed/timed-out
    // inspect is never proof of absence.
    const spawn = fakeSpawn({ cid: CID, afterRmRaw: { status: null, stdout: '', stderr: `Error: No such object: ${CID}`, error: { code: 'ETIMEDOUT' } } });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add(
      'removal treats an absence-inspect transport error as UNKNOWN, not absence',
      removal.removed === false && removal.unknown === true && /absence-transport/.test(removal.detail),
      JSON.stringify(removal),
    );
  }

  for (const [name, outcome] of [
    ['missing numeric inspect exit', { status: null }],
    ['signalled inspect', { status: 1, signal: 'SIGTERM' }],
    ['conflicting inspect stdout', { status: 1, stdout: CID }],
    ['multiline absence prefix', { status: 1, stderr: `Error:\nNo such object: ${CID}` }],
  ]) {
    const spawn = fakeSpawn({ cid: CID, afterRmRaw: { stderr: `Error: No such object: ${CID}`, ...outcome } });
    const removal = removeOwnedContainerById(CID, 'run-1', {}, { spawn });
    add(`removal refuses ${name}`, removal.removed === false && removal.unknown === true, JSON.stringify(removal));
  }

  // ---- S. round-46: the timeout/setup distinction on the REAL classifier path.
  //      Every control drives the PRODUCTION `runIsolated` through its seam and
  //      feeds the ACTUAL result to the PRODUCTION `classifyRun` (the run-smoke
  //      classifier), so the assertion is on the real result-to-status mapping:
  //      a definite `docker wait` deadline is a failing `timeout`, while every
  //      real setup/cleanup defect stays fail-closed and is never masked by a
  //      deadline.
  {
    const ENTRY = { kind: 'entrypoint', rel: 'x.mjs' };
    const CONTRACT = {
      noArgs: { documented: true, exit: 2, usagePrinted: true },
      help: { supported: false },
      evidence: 'isolation-control',
    };
    // Feed the ACTUAL runIsolated result to the ACTUAL classifier. The audit and
    // exec signals are supplied as the audit wrapper would set them, so the ONLY
    // variable under test is the lifecycle classification (timeout vs setup).
    const classifyFromRun = (r) => {
      const inv = { ...r, args: [], auditOk: true, entrypointExecuted: true, attempts: { network: [], write: [], permittedWrites: [] } };
      return classifyRun(ENTRY, inv, inv, inv, CONTRACT);
    };
    const drive = (cfg) => {
      const spawn = fakeSpawn({ cid: CID, ...cfg });
      const r = runIsolated({ repoRoot: process.cwd(), rel: 'x.mjs', _inject: { spawn, writePrestart: () => {} } });
      return { r, cls: classifyFromRun(r), spawn };
    };

    // S1. A DEFINITE wait deadline ⇒ failing `timeout` (never setup-incompatibility,
    //     and never a synthesised exit code).
    {
      const { r, cls, spawn } = drive({ waitTimeout: true });
      const wait = spawn.fullCalls.find((call) => call.args[0] === 'wait');
      add(
        'a DEFINITE wait deadline (ETIMEDOUT) is classified as a failing timeout, not setup-incompatibility',
        wait?.opts.killSignal === 'SIGTERM' && r.timedOut === true && r.setupError === false &&
          Number.isInteger(r.exit) === false && cls.status === 'timeout' && r.containerTerminated === true,
        JSON.stringify({ signal: wait?.opts.killSignal, timedOut: r.timedOut, setupError: r.setupError,
          exit: r.exit, status: cls.status, terminated: r.containerTerminated }),
      );
    }

    // S2. A NON-timeout wait TRANSPORT error (ENOENT) ⇒ fail-closed
    //     setup-incompatibility, never relabelled a timeout.
    {
      const { r, cls } = drive({ waitRaw: { status: null, error: { code: 'ENOENT' } } });
      add(
        'a NON-timeout wait transport error (ENOENT) fails closed as setup-incompatibility, never a timeout',
        r.timedOut === false && r.setupError === true && cls.status === 'setup-incompatibility',
        JSON.stringify({ timedOut: r.timedOut, setupError: r.setupError, status: cls.status }),
      );
    }

    // S3. Missing-tool logs WITH a deadline ⇒ still a fail-closed setup-incompatibility
    //     (the deadline must not mask the missing tool).
    {
      const { r, cls } = drive({ waitTimeout: true, logsStatus: 0, logsStderr: "Error: Cannot find module 'tsx'" });
      add(
        'missing-tool logs WITH a deadline still fail closed as setup-incompatibility (the deadline does not mask the missing tool)',
        r.timedOut === true && r.setupError === true && cls.status === 'setup-incompatibility',
        JSON.stringify({ timedOut: r.timedOut, setupError: r.setupError, status: cls.status }),
      );
    }

    // S4. Failed `docker logs` WITH a deadline ⇒ fail-closed setup-incompatibility.
    {
      const { r, cls } = drive({ waitTimeout: true, logsStatus: 1 });
      add(
        'a failed docker logs WITH a deadline fails closed as setup-incompatibility',
        r.timedOut === true && r.setupError === true && cls.status === 'setup-incompatibility',
        JSON.stringify({ timedOut: r.timedOut, setupError: r.setupError, status: cls.status }),
      );
    }

    // S5. Failed `docker start` WITH a deadline ⇒ fail-closed setup-incompatibility.
    {
      const { r, cls } = drive({ waitTimeout: true, startStatus: 1 });
      add(
        'a failed docker start WITH a deadline fails closed as setup-incompatibility',
        r.timedOut === true && r.setupError === true && cls.status === 'setup-incompatibility',
        JSON.stringify({ timedOut: r.timedOut, setupError: r.setupError, status: cls.status }),
      );
    }

    // S6. UNKNOWN cleanup WITH a deadline ⇒ fail-closed container-residual (removal
    //     is never assumed because the deadline fired).
    {
      const { r, cls } = drive({ waitTimeout: true, afterRm: 'unknown' });
      add(
        'an UNKNOWN cleanup WITH a deadline stays a fail-closed container-residual (removal is never assumed)',
        r.containerResidual === true && r.timedOut === true && cls.status === 'container-residual',
        JSON.stringify({ residual: r.containerResidual, removalDetail: r.removalDetail, timedOut: r.timedOut, status: cls.status }),
      );
    }
  }

  // ---- RC. committed-tsconfig selection + invocation binding ---------------
  // The isolated tsx previously ran with cwd=/src and NO committed tsconfig, so
  // decorated app source raised a TransformError. These controls prove the ACTUAL
  // `runIsolated` now binds the exact committed source-app config, and fails closed
  // (never a fabricated/default capability) when the config is absent/escaping.
  {
    // RC1: a .ts subject with a committed app tsconfig, mounted workspace /src.
    const repo = fixtureRepo('cleanup-smoke-cfg-ok-');
    const spawn = fakeSpawn({ cid: null });
    const subjectDeps = { volume: 'v', completed: true, verifiedLabel: true, label: 'l' };
    const r = runIsolated({ repoRoot: repo, rel: 'apps/api/scripts/probe.ts', subjectDeps, _inject: { spawn, writePrestart: () => {} } });
    const expected = ['node', 'apps/api/node_modules/tsx/dist/cli.mjs', '--tsconfig', '/src/apps/api/tsconfig.json', 'apps/api/scripts/probe.ts'];
    add(
      'a .ts subject is invoked with the committed source-app --tsconfig bound into native argv',
      r.runtimeConfig === '/src/apps/api/tsconfig.json' && r.runtimeConfigRel === 'apps/api/tsconfig.json' &&
        r.tsxLoader === 'apps/api/node_modules/tsx/dist/cli.mjs' &&
        JSON.stringify(r.nativeArgv) === JSON.stringify(expected),
      JSON.stringify({ nativeArgv: r.nativeArgv, runtimeConfig: r.runtimeConfig, runtimeConfigRel: r.runtimeConfigRel }),
    );
    add(
      'the bound command reaches the docker create invocation (subject args preserved in order)',
      spawn.calls.includes('create'),
      JSON.stringify({ calls: spawn.calls }),
    );
  }

  // RC2: a .ts subject with NO committed config on its chain FAILS CLOSED (no container).
  {
    const repo = fixtureRepo('cleanup-smoke-cfg-absent-', { withConfig: false });
    const spawn = fakeSpawn({ cid: 'a'.repeat(64) });
    const r = runIsolated({ repoRoot: repo, rel: 'apps/api/scripts/probe.ts', _inject: { spawn, writePrestart: () => {} } });
    add(
      'a .ts subject with no committed tsconfig fails closed (no fake/default config, no container)',
      r.setupError === true && r.runtimeConfigError === 'tsconfig-absent' && r.runtimeConfig === null && spawn.calls.length === 0,
      JSON.stringify({ setupError: r.setupError, runtimeConfigError: r.runtimeConfigError, calls: spawn.calls }),
    );
  }

  // RC3: without a subjectDeps /src mount the config binds its native container path.
  {
    const repo = fixtureRepo('cleanup-smoke-cfg-native-');
    const spawn = fakeSpawn({ cid: null });
    const r = runIsolated({ repoRoot: repo, rel: 'apps/api/scripts/probe.ts', _inject: { spawn, writePrestart: () => {} } });
    add(
      'without a /src mount the committed config binds its native container path (never /src)',
      Array.isArray(r.nativeArgv) && r.nativeArgv.includes('--tsconfig') &&
        String(r.runtimeConfig).endsWith('/apps/api/tsconfig.json') && !String(r.runtimeConfig).startsWith('/src/'),
      JSON.stringify({ nativeArgv: r.nativeArgv, runtimeConfig: r.runtimeConfig }),
    );
  }

  // RC4: an ESCAPING subject path is refused before any container.
  {
    const repo = fixtureRepo('cleanup-smoke-cfg-escape-');
    const spawn = fakeSpawn({ cid: 'a'.repeat(64) });
    const r = runIsolated({ repoRoot: repo, rel: '../outside.ts', _inject: { spawn, writePrestart: () => {} } });
    add(
      'an escaping .ts subject path is refused (subject-path-unsafe) before any container',
      r.setupError === true && r.runtimeConfigError === 'subject-path-unsafe' && spawn.calls.length === 0,
      JSON.stringify({ setupError: r.setupError, runtimeConfigError: r.runtimeConfigError, calls: spawn.calls }),
    );
  }

  // RC5: a non-TS (.mjs) subject carries NO loader and NO config.
  {
    const repo = mkdtempSync(join(tmpdir(), 'cleanup-smoke-cfg-mjs-'));
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'tool.mjs'), 'console.log(1);\n');
    const spawn = fakeSpawn({ cid: null });
    const r = runIsolated({ repoRoot: repo, rel: 'scripts/tool.mjs', _inject: { spawn, writePrestart: () => {} } });
    add(
      'a non-TS subject carries no tsx loader and no --tsconfig (unchanged direct node invocation)',
      Array.isArray(r.nativeArgv) && JSON.stringify(r.nativeArgv) === JSON.stringify(['node', 'scripts/tool.mjs']) &&
        r.runtimeConfig === null && r.tsxLoader === null,
      JSON.stringify({ nativeArgv: r.nativeArgv, runtimeConfig: r.runtimeConfig }),
    );
  }

  // ---- IC. canonical invocation-context planning + context-bound execution ---
  // These drive the ACTUAL planner and the ACTUAL `runIsolated` through `_inject`;
  // every assertion inspects REAL serialized create argv / receipts / call order.
  // No Docker daemon is contacted and no discovered script is executed.
  {
    const repo = contextFixture('cleanup-smoke-ctx-');
    const entries = discoverEntrypoints(repo);
    const toolEntry = entries.find((e) => e.rel === 'apps/api/scripts/tool.mjs');
    add(
      'context fixture: the physical CLI keeps ALL four declaration contexts (root/cd/filter/package-local)',
      !!toolEntry && Array.isArray(toolEntry.declaredContexts) && toolEntry.declaredContexts.length === 4,
      JSON.stringify({ declaredBy: toolEntry?.declaredBy, contexts: toolEntry?.declaredContexts?.length }),
    );

    const plan = planInvocationContexts(repo);
    const toolCtxs = plan.contexts.filter((c) => c.rel === 'apps/api/scripts/tool.mjs');
    const apiCtx = toolCtxs.find((c) => c.cwdRel === 'apps/api');
    const dotCtx = toolCtxs.find((c) => c.cwdRel === '.');
    add(
      'planner: one physical CLI declared from two distinct cwds yields exactly two canonical contexts',
      toolCtxs.length === 2 && new Set(toolCtxs.map((c) => c.cwdRel)).size === 2,
      JSON.stringify(toolCtxs.map((c) => ({ cwdRel: c.cwdRel, decls: c.declarations.length, key: c.contextKey }))),
    );
    add(
      'planner: equivalent declarations are GROUPED preserving ALL associated declarations',
      !!apiCtx && apiCtx.declarations.length === 3 && apiCtx.declarationRefs.length === 3 && !!dotCtx && dotCtx.declarations.length === 1,
      JSON.stringify({ api: apiCtx?.declarationRefs, dot: dotCtx?.declarationRefs }),
    );
    add(
      'planner: owning manifest input hashes are bound into the context provenance',
      !!apiCtx &&
        apiCtx.manifestInputs.some((m) => m.rel === 'package.json' && /^[0-9a-f]{64}$/.test(String(m.sha256))) &&
        apiCtx.manifestInputs.some((m) => m.rel === 'apps/api/package.json' && /^[0-9a-f]{64}$/.test(String(m.sha256))),
      JSON.stringify(apiCtx?.manifestInputs),
    );
    add(
      'planner: keys are STABLE and bound to rel+cwd',
      toolCtxs.every((c) => c.contextKey === `invctx::${c.rel}::${c.cwdRel}`),
      JSON.stringify(toolCtxs.map((c) => c.contextKey)),
    );
    add(
      'planner: two independent derivations are byte-identical (deterministic keys/provenance)',
      JSON.stringify(plan.contexts) === JSON.stringify(planInvocationContexts(repo).contexts),
      'deterministic',
    );
    add(
      'modes: the smoke supplies ONLY [], [--help], [<unknown-flag>] — no declaration flag is replayed',
      JSON.stringify(SMOKE_MODES) === JSON.stringify([[], ['--help'], ['--cleanup-smoke-unknown-flag']]),
      JSON.stringify(SMOKE_MODES),
    );
    add(
      'modes: a declaration carrying --commit is preserved as PROVENANCE but never turned into a mode arg',
      !!plan.contexts.flatMap((c) => c.declarations).find((d) => /--commit/.test(d.command ?? '')) &&
        !JSON.stringify(SMOKE_MODES).includes('--commit'),
      'commit flag is provenance only',
    );

    // An UNDECLARED walked subject keeps the HISTORICAL repo-root cwd '.'.
    {
      const bare = mkdtempSync(join(tmpdir(), 'cleanup-smoke-ctx-undeclared-'));
      mkdirSync(join(bare, 'apps', 'api', 'scripts'), { recursive: true });
      writeFileSync(join(bare, 'apps', 'api', 'scripts', 'probe.ts'), 'console.log(1);\n');
      const c = planInvocationContexts(bare).contexts.find((x) => x.rel === 'apps/api/scripts/probe.ts');
      add(
        'planner: an UNDECLARED physical subject keeps the historical repo-root cwd "." (no invented owner)',
        !!c && c.kind === 'entrypoint' && c.cwdRel === '.' && c.declarations.length === 0,
        JSON.stringify(c && { kind: c.kind, cwdRel: c.cwdRel, decls: c.declarations.length }),
      );
    }

    // ALL physical kinds retained; module/test/non-smoke excluded.
    {
      const mixed = deriveCanonicalContexts(
        [
          { rel: 'a.mjs', kind: 'entrypoint' },
          { rel: 'b.mjs', kind: 'unsafe' },
          { rel: 'c.mjs', kind: 'undiscovered-declared' },
          { rel: 'd.mjs', kind: 'module' },
          { rel: 'e.spec.mjs', kind: 'test' },
          { rel: 'f.mjs', kind: 'declared-non-smoke' },
        ],
        repo,
      );
      add(
        'planner: ALL physical kinds (entrypoint/unsafe/undiscovered-declared) are retained; module/test/non-smoke are excluded',
        mixed.counts.physicalSubjects === 3 &&
          mixed.subjects.map((s) => s.kind).sort().join(',') === 'entrypoint,undiscovered-declared,unsafe',
        JSON.stringify(mixed.counts),
      );
    }

    // Canonical cwd rejection: escaping / missing / unknown / symlink / non-dir.
    {
      const bare = mkdtempSync(join(tmpdir(), 'cleanup-smoke-ctx-cwd-'));
      const one = (cwdRel) =>
        deriveCanonicalContexts(
          [{ rel: 'scripts/x.mjs', kind: 'entrypoint', declaredContexts: [{ reference: 'p#s', packageDir: 'p', cwdRel }] }],
          bare,
        ).contexts[0];
      const esc = one('../outside');
      const miss = one('nope');
      const unknown = deriveCanonicalContexts(
        [{ rel: 'scripts/x.mjs', kind: 'entrypoint', declaredContexts: [{ reference: 'p#s', cwdRel: null }] }],
        bare,
      ).contexts[0];
      add('planner: an ESCAPING cwd is INVALID (never guessed)', esc.valid === false && esc.problems.includes('cwd-escaping'), JSON.stringify(esc.problems));
      add('planner: a MISSING cwd directory is INVALID (never guessed)', miss.valid === false && miss.problems.includes('cwd-missing'), JSON.stringify(miss.problems));
      add(
        'planner: an UNKNOWN cwd is an explicit INVALID context (never omitted)',
        unknown.valid === false && unknown.problems.includes('cwd-unknown') && unknown.cwdRel === null,
        JSON.stringify(unknown.problems),
      );
      const fakeFs = {
        existsSync: () => true,
        lstatSync: (p) => ({
          isSymbolicLink: () => /linkcwd/.test(String(p)),
          isDirectory: () => !/filecwd/.test(String(p)),
        }),
        realpathSync: (p) => String(p),
      };
      const link = deriveCanonicalContexts(
        [{ rel: 'scripts/x.mjs', kind: 'entrypoint', declaredContexts: [{ reference: 'p#s', cwdRel: 'linkcwd' }] }],
        '/root',
        { fs: fakeFs },
      ).contexts[0];
      const file = deriveCanonicalContexts(
        [{ rel: 'scripts/x.mjs', kind: 'entrypoint', declaredContexts: [{ reference: 'p#s', cwdRel: 'filecwd' }] }],
        '/root',
        { fs: fakeFs },
      ).contexts[0];
      add('planner: a SYMLINK cwd is refused (no symlink escape)', link.valid === false && link.problems.includes('cwd-symlink'), JSON.stringify(link.problems));
      add('planner: a NON-DIRECTORY cwd is refused', file.valid === false && file.problems.includes('cwd-not-directory'), JSON.stringify(file.problems));
      add(
        'planner: matching against an INVALID context is refused',
        matchInvocationContext({ rel: esc.rel, cwdRel: esc.cwdRel, fingerprint: esc.fingerprint }, { contexts: [esc] }).ok === false,
        'invalid context refused',
      );
    }

    // ---- context validation: refusals BEFORE any docker create --------------
    add(
      'context validation: an explicitly NULL context is refused before create',
      (() => {
        const s = fakeSpawn({ cid: CID });
        const r = runIsolated({ repoRoot: repo, rel: 'apps/api/scripts/tool.mjs', invocationContext: null, _inject: { spawn: s } });
        return r.setupError === true && r.invocationContextRejected === true && r.contextError === 'context-missing' && s.calls.length === 0 && r.prestartReceiptPath === null;
      })(),
      'null refused',
    );
    add(
      'context validation: a FORGED fingerprint is refused before create',
      (() => {
        const forged = { ...apiCtx, fingerprint: 'f'.repeat(64) };
        const s = fakeSpawn({ cid: CID });
        const r = runIsolated({ repoRoot: repo, rel: 'apps/api/scripts/tool.mjs', invocationContext: forged, _inject: { spawn: s } });
        return r.contextError === 'context-provenance-mismatch' && s.calls.length === 0;
      })(),
      'forged refused',
    );
    add(
      'context validation: a partial free-form cwd/key (no fingerprint) is refused before create',
      (() => {
        const s = fakeSpawn({ cid: CID });
        const r = runIsolated({ repoRoot: repo, rel: 'apps/api/scripts/tool.mjs', invocationContext: { rel: apiCtx.rel, cwdRel: apiCtx.cwdRel }, _inject: { spawn: s } });
        return r.contextError === 'context-partial-reference' && s.calls.length === 0;
      })(),
      'partial refused',
    );
    add(
      'context validation: a context for ANOTHER subject is refused before create',
      (() => {
        const s = fakeSpawn({ cid: CID });
        const r = runIsolated({ repoRoot: repo, rel: 'apps/api/scripts/probe.ts', invocationContext: apiCtx, _inject: { spawn: s } });
        return r.contextError === 'context-subject-mismatch' && s.calls.length === 0;
      })(),
      'wrong subject refused',
    );
    add(
      'context validation: a STALE context (owning manifest changed after planning) is refused before create',
      (() => {
        const repo3 = contextFixture('cleanup-smoke-ctx-stale-');
        const stale = planInvocationContexts(repo3).contexts.find((c) => c.rel === 'apps/api/scripts/tool.mjs' && c.cwdRel === 'apps/api');
        writeFileSync(
          join(repo3, 'apps', 'api', 'package.json'),
          JSON.stringify({ name: '@probe/api', scripts: { local: 'node scripts/tool.mjs', tslocal: 'tsx scripts/probe.ts', extra: 'node scripts/tool.mjs' } }),
        );
        const s = fakeSpawn({ cid: CID });
        const r = runIsolated({ repoRoot: repo3, rel: 'apps/api/scripts/tool.mjs', invocationContext: stale, _inject: { spawn: s } });
        return r.contextError === 'context-provenance-mismatch' && s.calls.length === 0;
      })(),
      'stale refused',
    );
    add(
      'context validation: a context MISSING contextKey is refused before create (even with a genuine fingerprint)',
      (() => {
        const missing = { ...apiCtx };
        delete missing.contextKey;
        const s = fakeSpawn({ cid: CID });
        const r = runIsolated({ repoRoot: repo, rel: 'apps/api/scripts/tool.mjs', invocationContext: missing, _inject: { spawn: s } });
        return r.setupError === true && r.invocationContextRejected === true && r.contextError === 'context-partial-reference' && s.calls.length === 0;
      })(),
      'missing contextKey refused',
    );
    add(
      'context validation: a context MISSING declarationRefs is refused before create (even with a genuine fingerprint)',
      (() => {
        const missing = { ...apiCtx };
        delete missing.declarationRefs;
        const s = fakeSpawn({ cid: CID });
        const r = runIsolated({ repoRoot: repo, rel: 'apps/api/scripts/tool.mjs', invocationContext: missing, _inject: { spawn: s } });
        return r.setupError === true && r.invocationContextRejected === true && r.contextError === 'context-partial-reference' && s.calls.length === 0;
      })(),
      'missing declarationRefs refused',
    );
    add(
      'context validation: CHANGED declaration metadata (with a copied genuine fingerprint) is refused before create',
      (() => {
        const forged = structuredClone(apiCtx);
        forged.declarations[0].command = 'node scripts/unrelated.mjs';
        const s = fakeSpawn({ cid: CID });
        const r = runIsolated({ repoRoot: repo, rel: 'apps/api/scripts/tool.mjs', invocationContext: forged, _inject: { spawn: s } });
        return r.setupError === true && r.invocationContextRejected === true && r.contextError === 'context-declarations-mismatch' && s.calls.length === 0;
      })(),
      'changed declarations refused',
    );

    // ---- context-bound execution: absolute subject/loader + WorkingDir proof -
    {
      const expectedApiCwd = nativeCwdFor('apps/api', { mountedVolume: true, nativeRoot: repo });
      const writes = [];
      const spawn = fakeSpawn({ cid: CID, workingDir: expectedApiCwd });
      const r = runIsolated({
        repoRoot: repo,
        rel: 'apps/api/scripts/tool.mjs',
        invocationContext: apiCtx,
        subjectDeps: { volume: 'v', completed: true, verifiedLabel: true },
        _inject: { spawn, writePrestart: (p, t) => writes.push({ p, t }) },
      });
      const create = spawn.fullCalls.find((c) => c.args[0] === 'create');
      const wIdx = create ? create.args.indexOf('-w') : -1;
      add(
        'context-bound: the actual create argv uses the DECLARED cwd and an ABSOLUTE subject',
        !!create && wIdx >= 0 && create.args[wIdx + 1] === '/src/apps/api' && create.args.includes('/src/apps/api/scripts/tool.mjs'),
        JSON.stringify(create?.args),
      );
      add(
        'context-bound: the exact owned CID WorkingDir is INSPECTED and matched BEFORE start',
        spawn.fullCalls.some((c) => c.args[0] === 'inspect' && /WorkingDir/.test(c.args[2] ?? '')) &&
          r.workingDirInspect?.verified === true &&
          r.workingDirInspect?.expected === '/src/apps/api' &&
          spawn.calls.includes('start') &&
          r.status === 0,
        JSON.stringify({ verified: r.workingDirInspect?.verified, calls: spawn.calls }),
      );
      const prestart = writes
        .map((w) => {
          try {
            return JSON.parse(w.t);
          } catch {
            return null;
          }
        })
        .filter(Boolean)[0];
      add(
        'context-bound: the immutable prestart receipt binds contextKey/nativeCwd/nativeSubject/WorkingDir proof',
        !!prestart &&
          prestart.contextKey === apiCtx.contextKey &&
          prestart.nativeCwd === '/src/apps/api' &&
          prestart.nativeSubject === '/src/apps/api/scripts/tool.mjs' &&
          prestart.workingDirInspect?.verified === true,
        JSON.stringify(prestart && { contextKey: prestart.contextKey, nativeCwd: prestart.nativeCwd, nativeSubject: prestart.nativeSubject }),
      );
    }

    // Native-bind equivalent (no /src volume): contained native cwd + ABSOLUTE subject.
    {
      const expectedNative = nativeCwdFor('apps/api', { mountedVolume: false, nativeRoot: repo });
      const spawn = fakeSpawn({ cid: CID, workingDir: expectedNative });
      const r = runIsolated({ repoRoot: repo, rel: 'apps/api/scripts/tool.mjs', invocationContext: apiCtx, _inject: { spawn, writePrestart: () => {} } });
      const create = spawn.fullCalls.find((c) => c.args[0] === 'create');
      const wIdx = create ? create.args.indexOf('-w') : -1;
      add(
        'context-bound native-bind: the create argv uses the contained native cwd and ABSOLUTE subject',
        !!create && wIdx >= 0 && create.args[wIdx + 1] === expectedNative && r.nativeSubject === `${expectedNative}/scripts/tool.mjs`,
        JSON.stringify({ cwd: create?.args[wIdx + 1], subject: r.nativeSubject }),
      );
    }

    // Legacy (no context) callers unchanged: relative subject, cwd=/src, no WD inspect.
    add(
      'legacy: a caller that supplies NO context keeps the relative subject, cwd=/src and no WorkingDir inspect',
      (() => {
        const s = fakeSpawn({ cid: CID });
        const r = runIsolated({
          repoRoot: repo,
          rel: 'apps/api/scripts/tool.mjs',
          subjectDeps: { volume: 'v', completed: true, verifiedLabel: true },
          _inject: { spawn: s, writePrestart: () => {} },
        });
        const c = s.fullCalls.find((x) => x.args[0] === 'create');
        const i = c ? c.args.indexOf('-w') : -1;
        return (
          !!c &&
          c.args[i + 1] === '/src' &&
          c.args.includes('apps/api/scripts/tool.mjs') &&
          r.nativeCwd === null &&
          r.nativeSubject === null &&
          !s.fullCalls.some((x) => x.args[0] === 'inspect' && /WorkingDir/.test(x.args[2] ?? ''))
        );
      })(),
      'legacy unchanged',
    );

    // Context-bound TS: ABSOLUTE volume tsx loader + exact committed tsconfig + ABSOLUTE subject.
    {
      const tsCtx = plan.contexts.find((c) => c.rel === 'apps/api/scripts/probe.ts' && c.cwdRel === 'apps/api');
      add('planner: the TS subject also carries its apps/api cwd context', !!tsCtx, JSON.stringify(tsCtx && { cwdRel: tsCtx.cwdRel, refs: tsCtx.declarationRefs }));
      const expectedCwd = nativeCwdFor('apps/api', { mountedVolume: true, nativeRoot: repo });
      const spawn = fakeSpawn({ cid: CID, workingDir: expectedCwd });
      const r = runIsolated({
        repoRoot: repo,
        rel: 'apps/api/scripts/probe.ts',
        invocationContext: tsCtx,
        subjectDeps: { volume: 'v', completed: true, verifiedLabel: true },
        _inject: { spawn, writePrestart: () => {} },
      });
      const expectedArgv = ['node', '/src/apps/api/node_modules/tsx/dist/cli.mjs', '--tsconfig', '/src/apps/api/tsconfig.json', '/src/apps/api/scripts/probe.ts'];
      add(
        'context-bound TS: the argv binds the ABSOLUTE volume tsx loader, the exact committed tsconfig and the ABSOLUTE subject',
        JSON.stringify(r.nativeArgv) === JSON.stringify(expectedArgv) &&
          r.tsxLoader === '/src/apps/api/node_modules/tsx/dist/cli.mjs' &&
          r.runtimeConfig === '/src/apps/api/tsconfig.json',
        JSON.stringify(r.nativeArgv),
      );
    }

    // A WRONG actual WorkingDir ⇒ fail closed, never start, exact-id cleanup, receipt retained.
    {
      const spawn = fakeSpawn({ cid: CID, workingDir: '/src/apps/defense-api' });
      const writes = [];
      const r = runIsolated({
        repoRoot: repo,
        rel: 'apps/api/scripts/tool.mjs',
        invocationContext: apiCtx,
        subjectDeps: { volume: 'v', completed: true, verifiedLabel: true },
        _inject: { spawn, writePrestart: (p, t) => writes.push(t) },
      });
      add(
        'context-bound: a WRONG actual WorkingDir fails closed, NEVER starts, and removes the exact owned id',
        r.setupError === true &&
          r.workingDirError === 'working-dir-mismatch' &&
          !spawn.calls.includes('start') &&
          spawn.calls.includes('rm') &&
          r.containerTerminated === true,
        JSON.stringify({ err: r.workingDirError, started: spawn.calls.includes('start'), calls: spawn.calls }),
      );
      add(
        'context-bound: the failed WorkingDir proof is retained in an immutable receipt',
        writes.length >= 1 &&
          (() => {
            try {
              return JSON.parse(writes[0]).workingDirInspect?.verified === false;
            } catch {
              return false;
            }
          })(),
        'receipt captured',
      );
    }
    {
      const spawn = fakeSpawn({ cid: CID, workingDirInspect: 'fail' });
      const r = runIsolated({
        repoRoot: repo,
        rel: 'apps/api/scripts/tool.mjs',
        invocationContext: apiCtx,
        subjectDeps: { volume: 'v', completed: true, verifiedLabel: true },
        _inject: { spawn, writePrestart: () => {} },
      });
      add(
        'context-bound: a WorkingDir inspect TRANSPORT failure fails closed (never starts, exact cleanup attempted)',
        r.setupError === true && r.workingDirError === 'inspect-transport' && !spawn.calls.includes('start') && spawn.calls.includes('rm'),
        JSON.stringify({ err: r.workingDirError, calls: spawn.calls }),
      );
    }

    // ---- LOSS: lossless WorkingDir inspection stdout/stderr bytes in the ACTUAL
    //      injected lifecycle result + immutable receipt. Docker's trailing newline
    //      is preserved (the old `raw=stdout.trim()` lost bytes); SHA-256/byte
    //      counts and the transport exit/signal/error + exact-CID/context binding
    //      are captured losslessly. Positive, strict-negative and all-omitted
    //      (legacy) cases are all covered.
    {
      const expectedApiCwd = nativeCwdFor('apps/api', { mountedVolume: true, nativeRoot: repo });
      const stdoutExact = JSON.stringify(expectedApiCwd) + '\n'; // Docker emits a trailing newline
      const stderrExact = 'WARNING: transient daemon telemetry\n';
      const spawn = fakeSpawn({ cid: CID, workingDirRaw: stdoutExact, workingDirStderr: stderrExact });
      const writes = [];
      const r = runIsolated({
        repoRoot: repo,
        rel: 'apps/api/scripts/tool.mjs',
        invocationContext: apiCtx,
        subjectDeps: { volume: 'v', completed: true, verifiedLabel: true },
        _inject: { spawn, writePrestart: (p, t) => writes.push({ p, t }) },
      });
      const wi = r.workingDirInspect;
      const shaOf = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
      add(
        'lossless inspect (positive): the VERIFIED WorkingDir keeps the EXACT stdout bytes (incl. trailing newline), stderr bytes, SHA-256 and byte counts',
        wi?.verified === true &&
          wi.stdoutRaw === stdoutExact &&
          wi.stderrRaw === stderrExact &&
          wi.stdoutBytes === Buffer.byteLength(stdoutExact, 'utf8') &&
          wi.stderrBytes === Buffer.byteLength(stderrExact, 'utf8') &&
          wi.stdoutSha256 === shaOf(stdoutExact) &&
          wi.stderrSha256 === shaOf(stderrExact) &&
          wi.inspectExit === 0 &&
          wi.inspectSignal === null &&
          wi.inspectError === null &&
          wi.exactContainerId === CID &&
          wi.contextKey === apiCtx.contextKey &&
          spawn.calls.includes('start'),
        JSON.stringify({ raw: wi?.stdoutRaw, bytes: wi?.stdoutBytes, sha: wi?.stdoutSha256, exit: wi?.inspectExit }),
      );
      const prestart = writes
        .map((w) => {
          try {
            return JSON.parse(w.t);
          } catch {
            return null;
          }
        })
        .filter(Boolean)[0];
      add(
        'lossless inspect (positive): the immutable prestart receipt carries the SAME lossless stdout/stderr bytes + status/exact-CID/context binding',
        !!prestart &&
          prestart.workingDirInspect?.stdoutRaw === stdoutExact &&
          prestart.workingDirInspect?.stderrRaw === stderrExact &&
          prestart.workingDirInspect?.stdoutSha256 === shaOf(stdoutExact) &&
          prestart.workingDirInspect?.stderrSha256 === shaOf(stderrExact) &&
          prestart.workingDirInspect?.stdoutBytes === Buffer.byteLength(stdoutExact, 'utf8') &&
          prestart.workingDirInspect?.exactContainerId === CID &&
          prestart.workingDirInspect?.contextKey === apiCtx.contextKey,
        JSON.stringify(prestart?.workingDirInspect && { raw: prestart.workingDirInspect.stdoutRaw, sha: prestart.workingDirInspect.stdoutSha256 }),
      );
    }
    {
      // STRICT NEGATIVE: a transport failure (nonzero exit + daemon stderr) never
      // starts and retains the exact stderr bytes + exit + exact-CID/context binding.
      const spawn = fakeSpawn({ cid: CID, workingDirInspect: 'fail' });
      const writes = [];
      const r = runIsolated({
        repoRoot: repo,
        rel: 'apps/api/scripts/tool.mjs',
        invocationContext: apiCtx,
        subjectDeps: { volume: 'v', completed: true, verifiedLabel: true },
        _inject: { spawn, writePrestart: (p, t) => writes.push({ p, t }) },
      });
      const wi = r.workingDirInspect;
      const shaOf = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
      add(
        'lossless inspect (strict negative): a transport-failed inspect never starts and retains exit/stderr bytes + hash + exact-CID/context binding',
        r.workingDirError === 'inspect-transport' &&
          !spawn.calls.includes('start') &&
          spawn.calls.includes('rm') &&
          r.containerTerminated === true &&
          wi?.verified === false &&
          wi.inspectExit === 1 &&
          wi.inspectSignal === null &&
          wi.stdoutBytes === 0 &&
          /Cannot connect to the Docker daemon/.test(wi.stderrRaw ?? '') &&
          wi.stderrSha256 === shaOf(wi.stderrRaw) &&
          wi.stderrBytes === Buffer.byteLength(wi.stderrRaw, 'utf8') &&
          wi.exactContainerId === CID &&
          wi.contextKey === apiCtx.contextKey,
        JSON.stringify({ err: r.workingDirError, exit: wi?.inspectExit, stderr: wi?.stderrRaw }),
      );
    }
    {
      // STRICT NEGATIVE: malformed JSON never starts and retains the raw bytes.
      const spawn = fakeSpawn({ cid: CID, workingDirInspect: 'malformed' });
      const r = runIsolated({
        repoRoot: repo,
        rel: 'apps/api/scripts/tool.mjs',
        invocationContext: apiCtx,
        subjectDeps: { volume: 'v', completed: true, verifiedLabel: true },
        _inject: { spawn, writePrestart: () => {} },
      });
      add(
        'lossless inspect (strict negative): a malformed inspect never starts and retains the raw bytes',
        r.workingDirError === 'inspect-malformed' &&
          !spawn.calls.includes('start') &&
          r.workingDirInspect?.verified === false &&
          r.workingDirInspect?.parseOk === false &&
          r.workingDirInspect?.stdoutRaw === 'not-json' &&
          r.workingDirInspect?.stdoutBytes === 8,
        JSON.stringify({ err: r.workingDirError, raw: r.workingDirInspect?.stdoutRaw }),
      );
    }
    {
      // ALL-OMITTED LEGACY: a caller that supplies NO context performs NO WorkingDir
      // inspect at all and carries a null inspection record.
      const spawn = fakeSpawn({ cid: CID });
      const r = runIsolated({
        repoRoot: repo,
        rel: 'apps/api/scripts/tool.mjs',
        subjectDeps: { volume: 'v', completed: true, verifiedLabel: true },
        _inject: { spawn, writePrestart: () => {} },
      });
      add(
        'lossless inspect (legacy all-omitted): no context ⇒ NO WorkingDir inspect and a null inspection record',
        r.workingDirInspect === null && !spawn.fullCalls.some((c) => c.args[0] === 'inspect' && /WorkingDir/.test(c.args[2] ?? '')),
        JSON.stringify({ inspect: r.workingDirInspect, calls: spawn.calls }),
      );
    }
  }

  const failed = checks.filter((c) => !c.ok);
  return { module: 'isolation-lifecycle-controls', checks, passed: checks.length - failed.length, total: checks.length, ok: failed.length === 0 };
}

export { runControls as runIsolationControls };

if (process.argv[1]?.endsWith('isolation-lifecycle-controls.mjs')) {
  const r = runControls();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
