/**
 * CleanUp1 §6.2 — lifecycle + readiness POLICY controls for the owned TS-runtime.
 *
 * These are executable controls (root runs them; NO Docker is touched here) that
 * import the ACTUAL `ts-runtime.mjs` and drive:
 *   - the owned-container lifecycle (`runOwnedContainer`) through its test-only
 *     `_inject` seam, and
 *   - the readiness/provision policy (`tsRuntimeProbe` / `provisionTsRuntime`)
 *     through the SAME seam (the availability check is routed through the injected
 *     spawn, so a pure control never calls a real Docker daemon).
 *
 * Lifecycle controls:
 *   - a failed `docker create` WITHOUT a readable cidfile is UNKNOWN — never
 *     "not-created";
 *   - a failed `docker create` WITH a valid durable id NEVER starts: the
 *     immutable prestart receipt (and a final receipt) are retained and the exact
 *     owned id is removed;
 *   - missing/na image identity is refused before any create (no mutable tag is
 *     ever used as a runtime identity);
 *   - unverified ownership (wrong id / wrong label / unknown inspect) NEVER
 *     starts and NEVER removes an unverified object, and now persists a SEPARATE
 *     final receipt;
 *   - a prestart-receipt write failure fails closed: the exact id is removed, a
 *     separate final receipt is retained, and the container is never started;
 *   - a failed `docker start`, an unavailable `docker wait`/`docker logs`, a
 *     malformed/out-of-range exit, and a wait TIMEOUT are each fail-closed — and
 *     the exact owned id is still removed on every one of those paths;
 *   - a spawn that THROWS during start/wait/logs is captured as a transport
 *     failure, the exact owned id is still removed, a separate final receipt is
 *     retained, and the result fails closed (`transport-threw`);
 *   - cleanup proof: exact-id-bound definite absence ⇒ removed; a nonzero `rm`, a
 *     GENERIC (non-exact-id) absence diagnostic and a daemon/unknown inspect each
 *     fail closed (containerResidual / removalUnknown);
 *   - an accepted success retains BOTH receipts and verified exact cleanup.
 *
 * Readiness / provision controls:
 *   - volume/image ABSENCE is bound to the EXACT complete name in a recognized
 *     Docker diagnostic — a different longer name is never accepted as absence;
 *   - a malformed successful volume inspect is UNKNOWN (never a fabricated
 *     existence);
 *   - `msgBindsExactAbsence` / `inspectRuntimeVolume` / `resolveRuntimeImage`
 *     exact-binding lookalikes;
 *   - the probe PARSES the marker JSON (JSON.parse, exact tsxVersion) and the
 *     native tsx version exactly: an exact positive, a well-formed version
 *     lookalike (`tsx v4.23.150`) rejected as `version-mismatch`, a malformed
 *     version rejected as UNKNOWN, marker mismatch vs malformed marker;
 *   - a GENERIC nonzero probe exit is UNKNOWN (refuses rewrite) while a
 *     recognized `MARKER_MISSING`/`CLI_MISSING` token is demonstrably incomplete;
 *   - `provisionTsRuntime` refuses a foreign / uncertain / post-create-wrong-name
 *     volume, honours the legacy `{image}` option, and REUSES a completed volume
 *     strictly READ-ONLY with no `volume create` mutation.
 *
 * Each control is a real assertion; the runner exits non-zero iff any control
 * fails. The seam is pure (in-memory spawn outcomes + a no-op receipt writer), so
 * NO container is created, started or removed by running this file. There is no
 * second parser and no reimplemented removal policy: removal flows through the
 * canonical `removeOwnedContainerById` imported by `ts-runtime.mjs`.
 *
 * Usage:
 *   node scripts/cleanup-script-smoke/ts-runtime-lifecycle-controls.mjs
 */
import { writeFileSync } from 'node:fs';
import {
  runOwnedContainer,
  tsRuntimeProbe,
  provisionTsRuntime,
  inspectRuntimeVolume,
  resolveRuntimeImage,
  msgBindsExactAbsence,
  parseNativeTsxVersion,
  parseMarkerVersion,
  TSX_VERSION,
  RUNTIME_IMAGE,
  TS_RUNTIME_VOLUME,
  OWNERSHIP_LABEL_VALUE,
  selectSourceAppTsConfig,
  subjectRelContained,
  TSX_TSCONFIG_FLAG,
  TS_SCRIPT_RE,
} from './ts-runtime.mjs';

const IMG = `sha256:${'a'.repeat(64)}`;
const CID = 'b'.repeat(64);
const WRONG_CID = 'c'.repeat(64);
/** A concrete, distinct volume name for the probe/provision controls. */
const VOL = TS_RUNTIME_VOLUME;
/** A valid, EXACT positive probe output (marker JSON + exact native version). */
const POSITIVE_LOGS = `MARKER:{"tsxVersion":"${TSX_VERSION}"}\nVERSION:tsx v${TSX_VERSION}\nnode v22.0.0\n`;

const res = (status, stdout = '', stderr = '') => ({ status, stdout, stderr, error: undefined });

/**
 * Build a fake docker spawn. It records the ordered subcommands (and full argv)
 * it saw, writes the cidfile on `create`, echoes the invocation's own ownership
 * label back on the ownership inspect, and takes a configurable removal outcome.
 * It also serves the non-container helpers (`version` availability, `volume`
 * inspect/create, `image` inspect) so probe/provision policy can be driven purely.
 */
function fakeSpawn(cfg = {}) {
  const calls = [];
  const argv = [];
  const options = [];
  let capturedLabel = 'run-1';
  const spawn = (cmd, args = [], opts = {}) => {
    calls.push(args[0]);
    argv.push([...args]);
    options.push({ ...opts });
    if (cmd !== 'docker') return res(1);
    const sub = args[0];
    if (cfg.throwOn && sub === cfg.throwOn) throw new Error(`simulated transport throw: ${sub}`);
    if (sub === 'version') return res(cfg.versionStatus ?? 0, '29.0.0', '');
    if (sub === 'volume') {
      const action = args[1];
      if (action === 'create') return res(cfg.volumeCreateStatus ?? 0, '', cfg.volumeCreateStderr ?? '');
      if (action === 'inspect') {
        const name = args[args.length - 1];
        if (typeof cfg.volumeInspect === 'function') return cfg.volumeInspect(name, args);
        // default: EXACT-name get-form absence
        return res(1, '', `Error response from daemon: get ${name}: no such volume`);
      }
      return res(1);
    }
    if (sub === 'image') {
      const ref = args[args.length - 1];
      if (cfg.imageAbsent) return res(1, '', `Error response from daemon: No such image: ${ref}`);
      if (cfg.imageUnknown) return res(1, '', 'Error response from daemon: timeout waiting for image metadata');
      return res(0, cfg.imageId ?? IMG, '');
    }
    if (sub === 'create') {
      const ci = args.indexOf('--cidfile');
      if (ci >= 0 && cfg.cid) { try { writeFileSync(args[ci + 1], cfg.cid); } catch { /* ignore */ } }
      const hit = args.find((x) => String(x).startsWith('cleanup-smoke.run='));
      if (hit) capturedLabel = String(hit).slice('cleanup-smoke.run='.length);
      return res(cfg.createStatus ?? 0, '', cfg.createStderr ?? '');
    }
    if (sub === 'start') return res(cfg.startStatus ?? 0, '', cfg.startStderr ?? '');
    if (sub === 'wait') {
      if (cfg.waitTimeout) return { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } };
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
      if (cfg.afterRm === 'present') return res(0, id, '');
      if (cfg.afterRm === 'absent-generic') return res(1, '', 'Error: No such container: deadbeefdeadbeef');
      if (cfg.afterRm === 'unknown') return res(1, '', 'Error response from daemon: timeout waiting for container');
      // default: exact-id-bound definite absence
      return res(1, '', `Error: No such container: ${id}`);
    }
    if (sub === 'rm') return res(cfg.rmStatus ?? 0, '', cfg.rmStderr ?? '');
    return res(1);
  };
  spawn.calls = calls;
  spawn.argv = argv;
  spawn.options = options;
  return spawn;
}

/** Drive one lifecycle control through the real runner with a pure seam. */
function drive(spawn, writeReceipt = () => {}) {
  return runOwnedContainer({
    kind: 'control',
    imageId: IMG,
    command: ['sh', '-lc', 'true'],
    _inject: { spawn, writeReceipt },
  });
}

/** Drive the real readiness probe with a pure seam (volume owned by default). */
function driveProbe(cfg = {}) {
  const spawn = fakeSpawn({ cid: CID, volumeInspect: (name) => res(0, `${name}|${OWNERSHIP_LABEL_VALUE}`, ''), ...cfg });
  const r = tsRuntimeProbe(VOL, { _inject: { spawn, writeReceipt: () => {} }, imageId: IMG });
  return { spawn, r };
}

/** The argv of the container `create` invocation(s) seen by a fake spawn. */
function containerCreateArgv(spawn) {
  return spawn.argv.filter((a) => a[0] === 'create');
}

/**
 * A PURE fs seam for the committed-tsconfig selector. `tree` maps a POSIX path to
 * its file content; `symlinks`/`dirs` mark non-regular entries; `escapeReal` maps a
 * path to a `realpathSync` result OUTSIDE the repo (to drive the escape refusal).
 * Incoming paths are backslash-normalized so `node:path.join` output on Windows
 * still resolves against the POSIX tree.
 */
function fakeConfigFs({ tree = {}, symlinks = [], dirs = [], escapeReal = {} } = {}) {
  const K = (p) => String(p).replace(/\\/g, '/');
  const present = (p) => {
    const k = K(p);
    return Object.prototype.hasOwnProperty.call(tree, k) || symlinks.includes(k) || dirs.includes(k);
  };
  return {
    sep: '/',
    existsSync: (p) => present(p),
    lstatSync: (p) => {
      const k = K(p);
      return { isSymbolicLink: () => symlinks.includes(k), isFile: () => !symlinks.includes(k) && !dirs.includes(k) };
    },
    realpathSync: (p) => escapeReal[K(p)] ?? K(p),
    readFileSync: (p) => {
      const v = tree[K(p)];
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
  };
}
function runControls() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  // ==== Lifecycle controls ====================================================

  // ---- A. failed create WITHOUT a readable cidfile ⇒ UNKNOWN ---------------
  {
    const spawn = fakeSpawn({ cid: null, createStatus: 1, createStderr: 'Error: failed to create' });
    const r = drive(spawn);
    add(
      'failed create without cid is UNKNOWN (not not-created)',
      r.ok === false && r.reason === 'create-unknown-no-cid' && r.containerCreated === false && r.containerId === null && r.removalUnknown === true && r.containerResidual === true && !spawn.calls.includes('start'),
      JSON.stringify({ reason: r.reason, created: r.containerCreated, id: r.containerId, unknown: r.removalUnknown, residual: r.containerResidual, calls: spawn.calls }),
    );
  }

  // ---- A2. create exit 0 but NO durable id ⇒ still UNKNOWN -----------------
  {
    const spawn = fakeSpawn({ cid: null, createStatus: 0 });
    const r = drive(spawn);
    add(
      'create exit 0 with no durable id is UNKNOWN and never starts',
      r.ok === false && r.reason === 'create-unknown-no-cid' && r.containerId === null && r.removalUnknown === true && !spawn.calls.includes('start'),
      JSON.stringify({ reason: r.reason, id: r.containerId, calls: spawn.calls }),
    );
  }

  // ---- B. failed create WITH a valid id ⇒ NEVER started, exact id removed ---
  {
    const writes = [];
    const spawn = fakeSpawn({ cid: CID, createStatus: 1, createStderr: 'Error: failed' });
    const r = drive(spawn, (p, t) => writes.push({ p, t }));
    add(
      'failed create with valid id never starts and retains the prestart receipt',
      r.reason === 'create-failed' && r.containerCreated === true && r.containerStarted === false && !spawn.calls.includes('start') && !!r.prestartReceiptPath && writes.length >= 1,
      JSON.stringify({ reason: r.reason, started: r.containerStarted, start_calls: spawn.calls.filter((c) => c === 'start').length, prestart: r.prestartReceiptPath }),
    );
    add(
      'failed create with valid id removes the exact owned id (definite absence)',
      r.containerCreated === true && r.containerTerminated === true && r.containerResidual === false && r.exit === null && r.setupError === true && r.finalReceiptPath !== null,
      JSON.stringify({ created: r.containerCreated, terminated: r.containerTerminated, residual: r.containerResidual, exit: r.exit }),
    );
  }

  // ---- B2. no image identity ⇒ refused before any create -------------------
  {
    const spawn = fakeSpawn({ cid: CID });
    const r = runOwnedContainer({ kind: 'control', imageId: 'node:22-alpine', command: ['sh', '-lc', 'true'], _inject: { spawn, writeReceipt: () => {} } });
    add(
      'a mutable tag is refused as an image identity before any create',
      r.ok === false && r.reason === 'image-id-unresolved' && !spawn.calls.includes('create'),
      JSON.stringify({ reason: r.reason, calls: spawn.calls }),
    );
  }

  // ---- C. unverified ownership ⇒ never starts, never removes, final receipt -
  for (const [name, cfg] of [
    ['wrong ownership label before start', { ownerLabel: 'foreign-run' }],
    ['wrong id before start', { ownerId: WRONG_CID }],
    ['unknown ownership inspect before start', { ownerInspect: 'fail' }],
  ]) {
    const spawn = fakeSpawn({ cid: CID, ...cfg });
    const r = drive(spawn);
    add(
      `${name} never starts or removes an unverified object (and records a separate final receipt)`,
      r.ok === false && r.reason === 'ownership-unverified' && !spawn.calls.includes('start') && !spawn.calls.includes('rm') && !!r.prestartReceiptPath && !!r.finalReceiptPath,
      JSON.stringify({ reason: r.reason, calls: spawn.calls, final: r.finalReceiptPath }),
    );
  }

  // ---- D. prestart-receipt write failure ⇒ fail closed, never starts -------
  {
    const spawn = fakeSpawn({ cid: CID, createStatus: 0 });
    const r = drive(spawn, (p) => { if (String(p).endsWith('.prestart.json')) throw new Error('simulated receipt write failure'); });
    add(
      'prestart receipt write failure fails closed and removes the exact id without starting (separate final receipt)',
      r.ok === false && r.reason === 'prestart-receipt-failed' && !!r.receiptError && r.containerTerminated === true && r.containerResidual === false && !spawn.calls.includes('start') && r.finalReceiptPath !== null,
      JSON.stringify({ reason: r.reason, receiptError: r.receiptError, terminated: r.containerTerminated, started: spawn.calls.includes('start'), final: r.finalReceiptPath }),
    );
  }

  // ---- E. failed start ⇒ fail-closed setup condition ----------------------
  {
    const spawn = fakeSpawn({ cid: CID, createStatus: 0, startStatus: 1, startStderr: 'Error: start failed' });
    const r = drive(spawn);
    add(
      'failed docker start is a fail-closed setup condition and removes the id',
      r.ok === false && r.reason === 'start-failed' && spawn.calls.includes('start') && !spawn.calls.includes('wait') && r.containerTerminated === true,
      JSON.stringify({ reason: r.reason, start_calls: spawn.calls.filter((c) => c === 'start').length, terminated: r.containerTerminated }),
    );
  }

  // ---- F/G/H. wait transport / logs transport / timeout ⇒ fail closed ------
  for (const [name, cfg, expectReason] of [
    ['failed wait transport', { waitStatus: 1, waitStdout: '0' }, 'wait-transport-failed'],
    ['failed log transport', { logsStatus: 1 }, 'logs-unavailable'],
    ['malformed exit status', { waitStdout: '0garbage' }, 'no-definite-exit'],
    ['out of range exit status', { waitStdout: '256' }, 'no-definite-exit'],
    ['wait timeout cleanup', { waitTimeout: true }, 'wait-timeout'],
  ]) {
    const spawn = fakeSpawn({ cid: CID, ...cfg });
    const r = drive(spawn);
    const residualCase = cfg.waitTimeout === true;
    const waitOptions = spawn.options[spawn.calls.indexOf('wait')];
    add(
      `${name} fails closed and removes the owned id`,
      r.ok === false && r.reason === expectReason && r.containerTerminated === true &&
        (residualCase ? r.timedOut === true && waitOptions?.killSignal === 'SIGTERM' : true),
      JSON.stringify({ reason: r.reason, timedOut: r.timedOut, terminated: r.containerTerminated,
        exit: r.exit, waitSignal: waitOptions?.killSignal }),
    );
  }

  // ---- E2. THROWN start/wait/logs transport ⇒ capture + cleanup + receipt ---
  for (const [name, throwOn] of [
    ['thrown start transport', 'start'],
    ['thrown wait transport', 'wait'],
    ['thrown logs transport', 'logs'],
  ]) {
    const spawn = fakeSpawn({ cid: CID, throwOn });
    const r = drive(spawn);
    add(
      `${name} is captured, cleaned up by exact id and recorded in a separate final receipt`,
      r.ok === false && r.reason === 'transport-threw' && !!r.transportError && r.containerTerminated === true && r.containerResidual === false && r.finalReceiptPath !== null && !!r.prestartReceiptPath,
      JSON.stringify({ reason: r.reason, transportError: r.transportError, terminated: r.containerTerminated, residual: r.containerResidual, final: r.finalReceiptPath }),
    );
  }

  // ---- I. final receipt write failure ⇒ fail closed after exact cleanup -----
  {
    const spawn = fakeSpawn({ cid: CID });
    const r = drive(spawn, (p) => { if (String(p).endsWith('.final.json')) throw new Error('final receipt failure'); });
    add(
      'final receipt write failure fails closed after exact cleanup',
      r.ok === false && r.reason === 'final-receipt-failed' && r.finalReceiptPath === null && r.containerTerminated === true,
      JSON.stringify({ reason: r.reason, finalReceipt: r.finalReceiptPath, terminated: r.containerTerminated }),
    );
  }

  // ---- J. nonzero rm ⇒ cleanup unverified (fail closed) --------------------
  {
    const spawn = fakeSpawn({ cid: CID, rmStatus: 1, rmStderr: 'rm failed' });
    const r = drive(spawn);
    add(
      'a nonzero rm leaves cleanup unverified and fails closed',
      r.ok === false && r.reason === 'cleanup-unverified' && r.containerTerminated === false && r.containerResidual === true && r.removalUnknown === true,
      JSON.stringify({ reason: r.reason, terminated: r.containerTerminated, unknown: r.removalUnknown }),
    );
  }

  // ---- K. generic absence / unknown inspect ⇒ cleanup unverified -----------
  for (const [name, cfg] of [
    ['generic non-exact-id absence', { afterRm: 'absent-generic' }],
    ['daemon/unknown absence inspect', { afterRm: 'unknown' }],
  ]) {
    const spawn = fakeSpawn({ cid: CID, ...cfg });
    const r = drive(spawn);
    add(
      `${name} cannot prove removal — cleanup unverified, fails closed`,
      r.ok === false && r.reason === 'cleanup-unverified' && r.containerResidual === true && r.removalUnknown === true,
      JSON.stringify({ reason: r.reason, residual: r.containerResidual, unknown: r.removalUnknown }),
    );
  }

  // ---- L. accepted success retains both receipts + verified cleanup --------
  {
    const spawn = fakeSpawn({ cid: CID });
    const r = drive(spawn);
    add(
      'successful lifecycle retains both receipts and exact cleanup',
      r.ok === true && r.reason === null && r.status === 0 && r.exit === 0 && !!r.prestartReceiptPath && !!r.finalReceiptPath && r.containerTerminated === true && r.containerResidual === false && r.setupError === false,
      JSON.stringify({ ok: r.ok, status: r.status, terminated: r.containerTerminated, prestart: !!r.prestartReceiptPath, final: !!r.finalReceiptPath }),
    );
  }

  // ==== Exact-name / exact-reference binding controls =========================

  // ---- M. inspectRuntimeVolume: a DIFFERENT longer name is NOT absence ------
  {
    const v = inspectRuntimeVolume('wanted', { spawn: () => ({ status: 1, stderr: 'Error: No such volume: wanted-other' }) });
    add(
      'volume inspect: a longer name containing the requested name is UNKNOWN, never absence',
      v.exists === false && v.unknown === true,
      JSON.stringify(v),
    );
  }

  // ---- M2. inspectRuntimeVolume: the root-observed get form binds EXACT name -
  {
    const name = 'cleanup-root-never-created-9b9dd0a423f849a39738b3c2b98eb5af';
    const v = inspectRuntimeVolume(name, { spawn: () => ({ status: 1, stderr: `Error response from daemon: get ${name}: no such volume` }) });
    add(
      'volume inspect: the daemon get-form binds the exact complete name as absence',
      v.exists === false && v.unknown === false && v.absent === true,
      JSON.stringify(v),
    );
  }

  // ---- M3. inspectRuntimeVolume: explicit "No such volume: <exact>" ---------
  {
    const v = inspectRuntimeVolume('myvol', { spawn: () => ({ status: 1, stderr: 'Error: No such volume: myvol' }) });
    add(
      'volume inspect: the explicit "No such volume: <exact>" form is absence',
      v.exists === false && v.unknown === false && v.absent === true,
      JSON.stringify(v),
    );
  }

  // ---- M4. inspectRuntimeVolume: malformed success is UNKNOWN ---------------
  for (const [name, stdout] of [
    ['no separator', `${VOL}`],
    ['empty name', `|${OWNERSHIP_LABEL_VALUE}`],
    ['too many fields', `a|b|c`],
  ]) {
    const v = inspectRuntimeVolume(VOL, { spawn: () => ({ status: 0, stdout, stderr: '' }) });
    add(
      `volume inspect: malformed success (${name}) is UNKNOWN, never a fabricated existence`,
      v.exists === false && v.unknown === true,
      JSON.stringify(v),
    );
  }

  // ---- M5. inspectRuntimeVolume: well-formed name|label success -------------
  {
    const owned = inspectRuntimeVolume(VOL, { spawn: () => ({ status: 0, stdout: `${VOL}|${OWNERSHIP_LABEL_VALUE}`, stderr: '' }) });
    const unlabeled = inspectRuntimeVolume(VOL, { spawn: () => ({ status: 0, stdout: `${VOL}|<no value>`, stderr: '' }) });
    add(
      'volume inspect: well-formed name|label parses (label present / <no value>)',
      owned.exists === true && owned.unknown === false && owned.name === VOL && owned.label === OWNERSHIP_LABEL_VALUE && unlabeled.exists === true && unlabeled.label === null,
      JSON.stringify({ owned, unlabeled }),
    );
  }

  // ---- N. resolveRuntimeImage: exact image absence vs reference prefix ------
  {
    const exact = resolveRuntimeImage('node:22-alpine', { spawn: () => ({ status: 1, stderr: 'Error response from daemon: No such image: node:22-alpine' }) });
    const prefix = resolveRuntimeImage('node', { spawn: () => ({ status: 1, stderr: 'Error response from daemon: No such image: node:22-alpine' }) });
    add(
      'image inspect: absence binds the exact reference; a shorter reference is UNKNOWN',
      exact.ok === false && exact.absent === true && exact.unknown === false && prefix.ok === false && prefix.unknown === true && !prefix.absent,
      JSON.stringify({ exact, prefix }),
    );
  }

  // ---- N2. msgBindsExactAbsence unit lookalikes -----------------------------
  {
    const cases = [
      ['volume get exact', 'Error response from daemon: get wanted: no such volume', 'wanted', 'volume', true],
      ['volume get longer', 'Error response from daemon: get wanted-other: no such volume', 'wanted', 'volume', false],
      ['volume explicit exact', 'Error: No such volume: wanted', 'wanted', 'volume', true],
      ['volume explicit longer', 'Error: No such volume: wanted-other', 'wanted', 'volume', false],
      ['volume generic daemon', 'Error response from daemon: timeout', 'wanted', 'volume', false],
      ['image explicit exact', 'Error response from daemon: No such image: node:22-alpine', 'node:22-alpine', 'image', true],
      ['image prefix', 'Error response from daemon: No such image: node:22-alpine', 'node', 'image', false],
      ['image get exact', 'Error response from daemon: get node:22-alpine: no such image', 'node:22-alpine', 'image', true],
    ];
    const ok = cases.every(([, msg, ref, noun, want]) => msgBindsExactAbsence(msg, ref, noun) === want);
    add('msgBindsExactAbsence binds the exact token only (no substring/prefix/suffix)', ok, JSON.stringify(cases));
  }

  // ==== Readiness probe controls ==============================================

  // ---- P1. EXACT positive ---------------------------------------------------
  {
    const { r } = driveProbe({ waitStdout: '0', logsStdout: POSITIVE_LOGS });
    add(
      'probe: an exact marker + exact native tsx version is READY',
      r.ok === true && r.unknown === false && r.version === `tsx v${TSX_VERSION}`,
      JSON.stringify({ ok: r.ok, version: r.version, reason: r.reason }),
    );
  }

  // ---- P2. native version lookalike (well-formed but different) -------------
  {
    const { r } = driveProbe({ waitStdout: '0', logsStdout: `MARKER:{"tsxVersion":"${TSX_VERSION}"}\nVERSION:tsx v4.23.150\nnode v22.0.0\n` });
    add(
      'probe: a well-formed version LOOKALIKE (tsx v4.23.150) is rejected as version-mismatch (not ready)',
      r.ok === false && r.unknown === false && r.reason === 'version-mismatch' && r.version === 'tsx v4.23.150',
      JSON.stringify({ ok: r.ok, unknown: r.unknown, reason: r.reason, version: r.version }),
    );
  }

  // ---- P3. malformed native version (prefix / prerelease suffix / missing) --
  for (const [name, logs] of [
    ['prefix', `MARKER:{"tsxVersion":"${TSX_VERSION}"}\nVERSION:xtsx v${TSX_VERSION}\n`],
    ['prerelease suffix', `MARKER:{"tsxVersion":"${TSX_VERSION}"}\nVERSION:tsx v${TSX_VERSION}-beta\n`],
    ['missing version line', `MARKER:{"tsxVersion":"${TSX_VERSION}"}\nnode v22.0.0\n`],
    ['duplicate version line', `MARKER:{"tsxVersion":"${TSX_VERSION}"}\nVERSION:tsx v${TSX_VERSION}\nVERSION:tsx v${TSX_VERSION}\n`],
  ]) {
    const { r } = driveProbe({ waitStdout: '0', logsStdout: logs });
    add(
      `probe: malformed native version (${name}) is UNKNOWN and refuses rewrite`,
      r.ok === false && r.unknown === true && r.reason === 'version-malformed',
      JSON.stringify({ ok: r.ok, unknown: r.unknown, reason: r.reason }),
    );
  }

  // ---- P4. marker JSON lookalikes ------------------------------------------
  {
    const mismatch = driveProbe({ waitStdout: '0', logsStdout: `MARKER:{"tsxVersion":"4.23.150"}\nVERSION:tsx v${TSX_VERSION}\n` }).r;
    add(
      'probe: a valid marker JSON with a DIFFERENT tsxVersion is marker-version-mismatch (repairable)',
      mismatch.ok === false && mismatch.unknown === false && mismatch.reason === 'marker-version-mismatch',
      JSON.stringify({ ok: mismatch.ok, unknown: mismatch.unknown, reason: mismatch.reason }),
    );
    for (const [name, marker] of [
      ['invalid JSON', 'MARKER:{tsxVersion:"4.23.15"}'],
      ['missing key', 'MARKER:{"version":"4.23.15"}'],
      ['duplicate line', `MARKER:{"tsxVersion":"${TSX_VERSION}"}\nMARKER:{"tsxVersion":"${TSX_VERSION}"}`],
    ]) {
      const r = driveProbe({ waitStdout: '0', logsStdout: `${marker}\nVERSION:tsx v${TSX_VERSION}\n` }).r;
      add(
        `probe: marker is PARSED, not grepped — malformed marker (${name}) is UNKNOWN`,
        r.ok === false && r.unknown === true && r.reason === 'marker-invalid',
        JSON.stringify({ ok: r.ok, unknown: r.unknown, reason: r.reason }),
      );
    }
  }

  // ---- P5. generic probe failure vs explicit recognized missing marker -----
  {
    const generic = driveProbe({ waitStdout: '1', logsStdout: 'some unexpected runtime error\n' }).r;
    add(
      'probe: a GENERIC nonzero probe exit is UNKNOWN (never permission to rewrite)',
      generic.ok === false && generic.unknown === true && generic.reason === 'probe-incomplete-unknown',
      JSON.stringify({ ok: generic.ok, unknown: generic.unknown, reason: generic.reason }),
    );
    const marker = driveProbe({ waitStdout: '3', logsStdout: 'MARKER_MISSING\n' }).r;
    const cli = driveProbe({ waitStdout: '4', logsStdout: 'CLI_MISSING\n' }).r;
    const esb = driveProbe({ waitStdout: '5', logsStdout: 'ESBUILD_MISSING\n' }).r;
    add(
      'probe: an explicitly recognized missing marker/CLI/esbuild is demonstrably incomplete (repairable, not unknown)',
      marker.unknown === false && marker.reason === 'marker-missing' && cli.unknown === false && cli.reason === 'cli-missing' && esb.unknown === false && esb.reason === 'esbuild-missing',
      JSON.stringify({ marker: marker.reason, cli: cli.reason, esbuild: esb.reason }),
    );
  }

  // ---- P6. direct parser lookalikes ----------------------------------------
  {
    const nat = parseNativeTsxVersion(`VERSION:tsx v${TSX_VERSION}\nnode v22.0.0\n`);
    const natBad = parseNativeTsxVersion(`VERSION:tsx v4.23.150\n`);
    const natMal = parseNativeTsxVersion(`VERSION:xtsx v${TSX_VERSION}\n`);
    const mk = parseMarkerVersion(`MARKER:{"tsxVersion":"${TSX_VERSION}"}\n`);
    const mkBad = parseMarkerVersion(`MARKER:{bad json}\n`);
    add(
      'parse helpers: exact native/marker parse; lookalikes/malformed are not ok',
      nat.ok === true && natBad.ok === false && natBad.reason === 'version-mismatch' && natMal.reason === 'version-malformed' && mk.ok === true && mkBad.ok === false && mkBad.reason === 'marker-invalid',
      JSON.stringify({ nat, natBad, natMal, mk, mkBad }),
    );
  }

  // ==== Provision / volume-ownership controls ================================

  // ---- Q. foreign (unowned) volume ⇒ refused, never mutated -----------------
  {
    const spawn = fakeSpawn({ cid: CID, volumeInspect: (name) => res(0, `${name}|foreign-label`, '') });
    const r = provisionTsRuntime({ volume: VOL, image: RUNTIME_IMAGE, _inject: { spawn, writeReceipt: () => {} } });
    add(
      'provision: a foreign/unowned volume is refused and never mutated',
      r.ok === false && r.reason === 'unowned-volume-refusing' && !spawn.calls.includes('create') && !spawn.argv.some((a) => a[0] === 'volume' && a[1] === 'create'),
      JSON.stringify({ reason: r.reason, calls: spawn.calls }),
    );
  }

  // ---- Q2. uncertain volume inspect ⇒ refused -------------------------------
  {
    const spawn = fakeSpawn({ cid: CID, volumeInspect: () => res(1, '', 'Error response from daemon: timeout waiting for volume inspect') });
    const r = provisionTsRuntime({ volume: VOL, image: RUNTIME_IMAGE, _inject: { spawn, writeReceipt: () => {} } });
    add(
      'provision: an UNCERTAIN volume inspect is UNKNOWN and refuses (never absence)',
      r.ok === false && r.reason === 'volume-inspect-unknown' && r.unknown === true,
      JSON.stringify({ reason: r.reason, unknown: r.unknown }),
    );
  }

  // ---- Q3. post-create WRONG NAME ⇒ ownership unverified, no container ------
  {
    let n = 0;
    const spawn = fakeSpawn({
      cid: CID,
      volumeInspect: (name) => { n += 1; return n === 1 ? res(1, '', `Error response from daemon: get ${name}: no such volume`) : res(0, `other-name|${OWNERSHIP_LABEL_VALUE}`, ''); },
    });
    const r = provisionTsRuntime({ volume: VOL, image: RUNTIME_IMAGE, _inject: { spawn, writeReceipt: () => {} } });
    add(
      'provision: a volume created with the WRONG name is ownership-unverified (no writable setup)',
      r.ok === false && r.reason === 'volume-ownership-unverified' && !spawn.calls.includes('create'),
      JSON.stringify({ reason: r.reason, calls: spawn.calls }),
    );
  }

  // ---- Q4. availability via the INJECTED spawn (pure, no real Docker) -------
  {
    const spawn = fakeSpawn({ cid: CID, versionStatus: 1 });
    const r = provisionTsRuntime({ volume: VOL, image: RUNTIME_IMAGE, _inject: { spawn, writeReceipt: () => {} } });
    const seamSpawn = fakeSpawn({ cid: CID });
    const r2 = provisionTsRuntime({ volume: VOL, image: RUNTIME_IMAGE, _inject: { spawn: seamSpawn, writeReceipt: () => {}, dockerAvailable: () => false } });
    add(
      'provision: availability is routed through the injected spawn / seam (no real Docker)',
      r.ok === false && r.reason === 'docker-unavailable' && !spawn.calls.includes('volume') && r2.ok === false && r2.reason === 'docker-unavailable' && !seamSpawn.calls.includes('version'),
      JSON.stringify({ reason: r.reason, calls: spawn.calls, seamReason: r2.reason, seamCalls: seamSpawn.calls }),
    );
  }

  // ---- Q5. owned volume + GENERIC probe failure ⇒ refuse repair -------------
  {
    const spawn = fakeSpawn({ cid: CID, volumeInspect: (name) => res(0, `${name}|${OWNERSHIP_LABEL_VALUE}`, ''), waitStdout: '1', logsStdout: 'some unexpected runtime error\n' });
    const r = provisionTsRuntime({ volume: VOL, image: RUNTIME_IMAGE, _inject: { spawn, writeReceipt: () => {} } });
    add(
      'provision: an owned volume whose probe is UNKNOWN refuses automatic repair',
      r.ok === false && r.reason === 'owned-volume-uncertain-refusing-repair' && r.probe && r.probe.unknown === true,
      JSON.stringify({ reason: r.reason, probeReason: r.probe?.reason }),
    );
  }

  // ---- Q6. completed owned volume REUSED strictly READ-ONLY, no mutation ----
  for (const [label, opt] of [['legacy image option', { image: RUNTIME_IMAGE }], ['reference option', { reference: RUNTIME_IMAGE }]]) {
    const spawn = fakeSpawn({ cid: CID, volumeInspect: (name) => res(0, `${name}|${OWNERSHIP_LABEL_VALUE}`, ''), waitStdout: '0', logsStdout: POSITIVE_LOGS });
    const r = provisionTsRuntime({ volume: VOL, ...opt, _inject: { spawn, writeReceipt: () => {} } });
    const creates = containerCreateArgv(spawn);
    const mountedReadOnly = creates.some((a) => a.includes(`type=volume,src=${VOL},dst=/tsruntime,readonly`) && a.includes('--network') && a[a.indexOf('--network') + 1] === 'none');
    add(
      `provision: a completed owned volume (${label}) is REUSED read-only with no volume mutation`,
      r.ok === true && r.reused === true && r.built === false && r.version === `tsx v${TSX_VERSION}` && !spawn.argv.some((a) => a[0] === 'volume' && a[1] === 'create') && creates.length >= 1 && mountedReadOnly,
      JSON.stringify({ ok: r.ok, reused: r.reused, built: r.built, version: r.version, creates: creates.length, mountedReadOnly }),
    );
  }

  // ==== Committed-tsconfig SELECTION controls (pure; no Docker, no disk) ======
  // The selector picks the NEAREST committed tsconfig.json on the subject's OWN
  // source-app chain (it ascends only, so it can never reach a sibling app), and
  // fails closed on absent / symlinked / non-file / escaping / malformed config.
  {
    const ROOT = '/repo';
    const good = '{"compilerOptions":{"experimentalDecorators":true}}';
    const baseTree = { [`${ROOT}/apps/api/tsconfig.json`]: good };

    // (a) nearest real config for an app subject (and a nested one).
    {
      const fs = fakeConfigFs({ tree: baseTree });
      const r1 = selectSourceAppTsConfig(ROOT, 'apps/api/scripts/x.ts', { fs });
      const r2 = selectSourceAppTsConfig(ROOT, 'apps/api/scripts/nested/deep/y.ts', { fs });
      add(
        'selector: the NEAREST committed source-app tsconfig is chosen for an app subject',
        r1.ok === true && r1.configRel === 'apps/api/tsconfig.json' && r2.ok === true && r2.configRel === 'apps/api/tsconfig.json',
        JSON.stringify({ r1, r2 }),
      );
    }

    // (b) a DIFFERENT app's config is NEVER applied (walk ascends only).
    {
      const fs = fakeConfigFs({ tree: { [`${ROOT}/apps/web/tsconfig.json`]: good, [`${ROOT}/apps/api/tsconfig.json`]: good } });
      const r = selectSourceAppTsConfig(ROOT, 'apps/api/scripts/x.ts', { fs });
      add(
        'selector: a sibling app config is never applied (nearest on the SUBJECT chain only)',
        r.ok === true && r.configRel === 'apps/api/tsconfig.json',
        JSON.stringify(r),
      );
    }

    // (c) non-TS subject => not applicable (no loader, no config).
    {
      const fs = fakeConfigFs({ tree: baseTree });
      const r = selectSourceAppTsConfig(ROOT, 'scripts/tool.mjs', { fs });
      add(
        'selector: a non-TS subject is not applicable (no config, no loader)',
        r.ok === true && r.applicable === false && r.configRel === null,
        JSON.stringify(r),
      );
    }

    // (d) absent config => fail closed (no fabricated/default config).
    {
      const fs = fakeConfigFs({ tree: {} });
      const r = selectSourceAppTsConfig(ROOT, 'scripts/legiwatch/x.ts', { fs });
      add(
        'selector: no committed tsconfig on the chain FAILS CLOSED (tsconfig-absent)',
        r.ok === false && r.reason === 'tsconfig-absent',
        JSON.stringify(r),
      );
    }

    // (e) escaping subject rel => fail closed.
    {
      const fs = fakeConfigFs({ tree: baseTree });
      const r = selectSourceAppTsConfig(ROOT, '../outside.ts', { fs });
      add(
        'selector: an escaping subject rel FAILS CLOSED (subject-path-unsafe)',
        r.ok === false && r.reason === 'subject-path-unsafe',
        JSON.stringify(r),
      );
    }

    // (f) symlinked config => fail closed.
    {
      const fs = fakeConfigFs({ tree: {}, symlinks: [`${ROOT}/apps/api/tsconfig.json`] });
      const r = selectSourceAppTsConfig(ROOT, 'apps/api/scripts/x.ts', { fs });
      add(
        'selector: a SYMLINKED tsconfig FAILS CLOSED (tsconfig-symlink)',
        r.ok === false && r.reason === 'tsconfig-symlink',
        JSON.stringify(r),
      );
    }

    // (g) a directory named tsconfig.json => fail closed.
    {
      const fs = fakeConfigFs({ tree: {}, dirs: [`${ROOT}/apps/api/tsconfig.json`] });
      const r = selectSourceAppTsConfig(ROOT, 'apps/api/scripts/x.ts', { fs });
      add(
        'selector: a non-file tsconfig FAILS CLOSED (tsconfig-not-file)',
        r.ok === false && r.reason === 'tsconfig-not-file',
        JSON.stringify(r),
      );
    }

    // (h) config realpath escapes the repo => fail closed.
    {
      const fs = fakeConfigFs({ tree: baseTree, escapeReal: { [`${ROOT}/apps/api/tsconfig.json`]: '/elsewhere/tsconfig.json' } });
      const r = selectSourceAppTsConfig(ROOT, 'apps/api/scripts/x.ts', { fs });
      add(
        'selector: a config resolving OUTSIDE the repo FAILS CLOSED (tsconfig-escaping)',
        r.ok === false && r.reason === 'tsconfig-escaping',
        JSON.stringify(r),
      );
    }

    // (i) malformed / non-compilerOptions JSON => fail closed.
    {
      const bad = fakeConfigFs({ tree: { [`${ROOT}/apps/api/tsconfig.json`]: '{ not json' } });
      const noCo = fakeConfigFs({ tree: { [`${ROOT}/apps/api/tsconfig.json`]: '{"extends":"./x"}' } });
      const r1 = selectSourceAppTsConfig(ROOT, 'apps/api/scripts/x.ts', { fs: bad });
      const r2 = selectSourceAppTsConfig(ROOT, 'apps/api/scripts/x.ts', { fs: noCo });
      add(
        'selector: malformed or compilerOptions-less tsconfig FAILS CLOSED (tsconfig-invalid)',
        r1.ok === false && r1.reason === 'tsconfig-invalid' && r2.ok === false && r2.reason === 'tsconfig-invalid',
        JSON.stringify({ r1, r2 }),
      );
    }

    // (j) the flag + extension constants are exactly the tsx-committed shapes.
    add(
      'the tsx config flag and TS-script matcher are the exact committed shapes',
      TSX_TSCONFIG_FLAG === '--tsconfig' && TS_SCRIPT_RE.test('a/b/c.ts') === true && TS_SCRIPT_RE.test('a/b/c.mjs') === false &&
        subjectRelContained('apps/api/scripts/x.ts') === true && subjectRelContained('/abs/x.ts') === false && subjectRelContained('a/../x.ts') === false,
      JSON.stringify({ flag: TSX_TSCONFIG_FLAG }),
    );
  }

  const failed = checks.filter((c) => !c.ok);
  return { module: 'ts-runtime-lifecycle-controls', checks, passed: checks.length - failed.length, total: checks.length, ok: failed.length === 0 };
}

export { runControls as runTsRuntimeControls };

if (process.argv[1]?.endsWith('ts-runtime-lifecycle-controls.mjs')) {
  const r = runControls();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
