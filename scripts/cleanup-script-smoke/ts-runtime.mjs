/**
 * CleanUp1 §6.2 — task-owned, Linux-native TS runtime for the isolated smoke.
 *
 * The host workspace's tsx tree is win32-only (its esbuild binary is
 * @esbuild/win32-x64), so it cannot run inside the Linux container. This module
 * provisions a UNIQUELY OWNED Docker VOLUME containing an exact-version,
 * Linux-native tsx (+ its linux-x64 esbuild and transitive deps), installed once
 * in a network-enabled SETUP step. The volume is then mounted READ-ONLY into the
 * --network-none audit container, so the actual script invocation never touches
 * the network and never reads the host node_modules.
 *
 * Round-22 hardening (root review): NO Docker CLI is unbounded, and NO runtime
 * container is `docker run --rm`-managed. Both the readiness PROBE and the
 * network-enabled SETUP container are created with `docker create --cidfile`, a
 * UNIQUE `cleanup-smoke.run=<runId>` label, the exact id persisted in an
 * immutable `wx` prestart receipt BEFORE any start, and the exact id+label
 * ownership verified BEFORE start. A failed create with a durable id is removed
 * (and NEVER started); a create with NO readable id is UNKNOWN — never
 * "not-created". Removal REUSES the canonical `removeOwnedContainerById`
 * (exact-id-bound definite absence) — never a name/prefix delete and never a
 * reimplemented removal policy. Container creation uses the exact full inspected
 * image Id (resolved at runtime, never a hardcoded host-only id); setup and
 * readiness share the same ABI image family and BOTH record the resolved id.
 *
 * The probe volume is mounted READ-ONLY with `--network none`; setup uses the
 * bridge network ONLY for the pinned tsx install and never mounts host
 * source/dependency/credential material.
 *
 * An existing volume that lacks OUR ownership label is NEVER mutated, rebuilt or
 * deleted. An existing OWNED volume whose state is UNCERTAIN refuses automatic
 * repair; only a demonstrably incomplete OWN setup (a definite probe exit naming
 * a missing marker/CLI/esbuild, or a marker/CLI version mismatch) is repaired,
 * and only with the exact ownership label plus that explicit evidence. A failed
 * probe TRANSPORT is never treated as permission to rewrite.
 *
 * Round-23 hardening (root review): absence (volume OR image) is bound to the
 * EXACT, COMPLETE requested name in a recognized Docker diagnostic — never a
 * substring/prefix/suffix — and a malformed successful inspect is UNKNOWN. The
 * probe PARSES the marker JSON (JSON.parse, exact `tsxVersion`) and the native tsx
 * version line EXACTLY; a lookalike (e.g. `tsx v4.23.150`) is rejected and only an
 * explicitly recognized missing marker/CLI/esbuild or a VALID known marker/version
 * mismatch is repairable — a generic/unknown probe exit or a malformed version is
 * UNKNOWN and refuses rewrite. `provisionTsRuntime` accepts the legacy `{image}`
 * option, normalizes to ONE reference, and uses the SAME resolved image Id for
 * setup and probe (threading `receiptsDir` into both). A spawn that THROWS during
 * start/wait/logs is captured, still cleaned up by exact id, recorded in a
 * separate final receipt and failed closed. Availability is checked through the
 * injected spawn so pure controls never touch a real Docker daemon.
 *
 * No host .pnpm copy, no user/repo credentials, no full host mounts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dockerAvailable,
  removeOwnedContainerById,
  selectSourceAppTsConfig,
  subjectRelContained,
  TSX_TSCONFIG_FLAG,
  TS_SCRIPT_RE,
} from './isolation.mjs';

export const TSX_VERSION = '4.23.15';
/** Task owner tag: makes the volume name uniquely OURS, never a shared default. */
export const RUNTIME_OWNER = 'hermes';
/** Volume name is a function of the pinned version AND our owner tag. */
export const TS_RUNTIME_VOLUME = `cleanup-smoke-tsruntime-${RUNTIME_OWNER}-${TSX_VERSION.replace(/[^0-9a-z]/gi, '_')}`;
/** tsx CLI path relative to the volume root (mounted at /tsruntime). */
export const TS_RUNTIME_CLI_REL = 'node_modules/tsx/dist/cli.mjs';
export const TS_RUNTIME_MARKER = '.cleanup-smoke-tsruntime.json';
export const OWNERSHIP_LABEL_KEY = 'cleanup.smoke-tsruntime';
export const OWNERSHIP_LABEL_VALUE = `tsx-${TSX_VERSION}`;
export const RUNTIME_IMAGE = 'node:22-alpine';
/** Shared run-label key: the canonical removeOwnedContainerById matches on this. */
export const RUNTIME_RUN_LABEL_KEY = 'cleanup-smoke.run';
/** Every Docker CLI invocation is bounded. */
export const RUNTIME_BOUND = { inspect: 10000, create: 30000, start: 20000, logs: 15000, rm: 15000, volume: 15000 };
export const RUNTIME_READY_WAIT_MS = 120000;
export const RUNTIME_SETUP_WAIT_MS = 300000;

/**
 * Committed-tsconfig binding for the isolated TS runtime.
 *
 * The isolated tsx executes a subject with `cwd=/src`, where the committed
 * source-app `tsconfig.json` (which enables `experimentalDecorators` /
 * `emitDecoratorMetadata` for Nest-decorated app source) is NOT found — so the
 * transform dropped decorator support and decorated imports raised a TransformError.
 * The runner now passes the EXACT nearest committed source-app config to tsx via
 * `TSX_TSCONFIG_FLAG` and binds it into native argv, the trace proof and the
 * receipt provenance. The selection (`selectSourceAppTsConfig`) ascends ONLY the
 * subject's own directory chain (never into a sibling app), and refuses an
 * absent / symlinked / non-file / escaping / malformed config. Re-exported here so
 * the TS-runtime module owns the concept; the ACTUAL invocation lives in
 * `isolation.mjs#runIsolated`.
 */
export { selectSourceAppTsConfig, subjectRelContained, TSX_TSCONFIG_FLAG, TS_SCRIPT_RE };

/** An image identity is the exact full inspected id, never a mutable tag alone. */
const RUNTIME_IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;

const slugify = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');

/**
 * True ONLY when `msg` carries a recognized Docker absence diagnostic that binds
 * the EXACT, COMPLETE requested name/reference — never a substring/prefix/suffix.
 * Recognized forms:
 *   - the get form Docker actually emits for volumes:
 *       "... get <name>: no such volume"
 *   - the explicit form for volumes and images:
 *       "No such volume: <name>" / "No such image: <ref>"
 * Match the complete diagnostic, then compare the captured name exactly.
 */
export function msgBindsExactAbsence(msg, name, noun) {
  if (!name || !['volume', 'image'].includes(noun)) return false;
  const text = String(msg ?? '').trim();
  const explicit = /^(?:Error(?: response from daemon)?:\s*)?No such (volume|image):\s*(\S+)\s*$/i.exec(text);
  const get = /^(?:Error(?: response from daemon)?:\s*)?get (\S+): no such (volume|image)$/i.exec(text);
  return (explicit?.[1]?.toLowerCase() === noun && explicit[2] === name) ||
    (get?.[2]?.toLowerCase() === noun && get[1] === name);
}

/** Bounded docker spawn used by the non-container docker helpers. */
export function dockerSync(args, { timeout = RUNTIME_BOUND.inspect, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, maxBuffer, timeout, killSignal: 'SIGKILL' });
}

/** Condense a spawn result into bounded raw stdout/stderr/status evidence. */
function statusObj(r) {
  if (!r) return null;
  return {
    status: r.status ?? null,
    stdout: `${r.stdout ?? ''}`,
    stderr: `${r.stderr ?? ''}`,
    error: r.error ? (r.error.code ?? r.error.message ?? 'spawn-error') : null,
  };
}

/**
 * Availability checked through the SAME spawn the rest of the module uses (when a
 * pure seam is injected), so control runs never touch a real Docker daemon. In
 * production (no injected spawn) this keeps the canonical `dockerAvailable()`.
 */
function dockerAvailability(spawn, deps) {
  if (typeof deps?.dockerAvailable === 'function') return deps.dockerAvailable() === true;
  if (spawn !== spawnSync) {
    const r = spawn('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8', windowsHide: true, timeout: RUNTIME_BOUND.inspect, killSignal: 'SIGKILL',
    });
    return !!r && r.status === 0;
  }
  return dockerAvailable() === true;
}

/**
 * Resolve the mutable image reference to its EXACT full inspected image Id.
 * An absent image is reported distinctly from an unknown daemon/inspect failure;
 * a non-`sha256:…` id is UNKNOWN (never trusted as an identity). Absence requires
 * the EXACT complete reference in a recognized diagnostic (never a substring).
 */
export function resolveRuntimeImage(reference = RUNTIME_IMAGE, { spawn = spawnSync } = {}) {
  const r = spawn('docker', ['image', 'inspect', '--format', '{{.Id}}', reference], {
    encoding: 'utf8', windowsHide: true, timeout: RUNTIME_BOUND.inspect, killSignal: 'SIGKILL',
  });
  if (r.status === 0) {
    const id = `${r.stdout ?? ''}`.trim();
    if (RUNTIME_IMAGE_ID_RE.test(id)) return { ok: true, reference, id, unknown: false };
    return { ok: false, reference, id: null, unknown: true, detail: `unparsable image id ${JSON.stringify(id.slice(0, 80))}` };
  }
  const msg = `${r.stderr ?? ''}${r.error?.code ? ` (${r.error.code})` : ''}`.trim();
  if (msgBindsExactAbsence(msg, reference, 'image')) {
    return { ok: false, reference, id: null, unknown: false, absent: true, detail: msg.slice(0, 200) };
  }
  return { ok: false, reference, id: null, unknown: true, detail: msg.slice(0, 200) || 'image inspect failed' };
}

/**
 * Bounded, STRICT volume inspect. `exists` is only reported for a well-formed
 * `name|label` line (exactly two fields, nonempty name); any malformed output is
 * UNKNOWN — never a fabricated existence. `absent` is only reported when the
 * diagnostic names the EXACT, COMPLETE requested volume; a daemon/timeout/any
 * other failure (or a DIFFERENT name) is UNKNOWN — never absence. Never mutates.
 */
export function inspectRuntimeVolume(volume = TS_RUNTIME_VOLUME, { spawn = spawnSync } = {}) {
  const r = spawn(
    'docker',
    ['volume', 'inspect', '--format', `{{.Name}}|{{ index .Labels "${OWNERSHIP_LABEL_KEY}" }}`, volume],
    { encoding: 'utf8', windowsHide: true, timeout: RUNTIME_BOUND.volume, killSignal: 'SIGKILL' },
  );
  if (r.status === 0) {
    const out = `${r.stdout ?? ''}`.trim();
    const parts = out.split('|');
    if (parts.length !== 2 || parts[0] === '') {
      return { exists: false, unknown: true, detail: `malformed volume inspect output ${JSON.stringify(out.slice(0, 120))}` };
    }
    const [name, label] = parts;
    return { exists: true, unknown: false, name, label: label && label !== '<no value>' ? label : null };
  }
  const msg = `${r.stderr ?? ''}${r.error?.code ? ` (${r.error.code})` : ''}`.trim();
  if (msgBindsExactAbsence(msg, volume, 'volume')) return { exists: false, unknown: false, absent: true, detail: msg.slice(0, 200) };
  return { exists: false, unknown: true, detail: msg.slice(0, 200) || 'volume inspect failed (daemon/timeout)' };
}

export function tsRuntimeVolumeExists(volume = TS_RUNTIME_VOLUME, opts = {}) {
  const v = inspectRuntimeVolume(volume, opts);
  return v.exists === true && v.unknown === false;
}

/** The volume's OUR ownership label value, or null when absent/unowned/unknown. */
export function tsRuntimeOwnership(volume = TS_RUNTIME_VOLUME, opts = {}) {
  const v = inspectRuntimeVolume(volume, opts);
  if (v.exists !== true || v.unknown === true) return null;
  return v.label ?? null;
}

export function tsRuntimeOwned(volume = TS_RUNTIME_VOLUME, opts = {}) {
  return tsRuntimeOwnership(volume, opts) === OWNERSHIP_LABEL_VALUE;
}

/**
 * The shell probe script: strict marker/CLI/linux-esbuild checks plus the RAW
 * marker JSON and the native tsx version output, each emitted verbatim so the
 * caller can PARSE them (JSON.parse + an exact version match) instead of trusting
 * a substring grep of possibly-malformed output. Each failure echoes an explicit,
 * machine-recognized token immediately before its fail-closed exit.
 */
function probeScript() {
  return [
    'set -e',
    `f=/tsruntime/${TS_RUNTIME_MARKER}`,
    'test -f "$f" || { echo MARKER_MISSING; exit 3; }',
    `test -f /tsruntime/${TS_RUNTIME_CLI_REL} || { echo CLI_MISSING; exit 4; }`,
    'test -d /tsruntime/node_modules/@esbuild/linux-x64 || { echo ESBUILD_MISSING; exit 5; }',
    'echo "MARKER:$(cat "$f")"',
    `v=$(node /tsruntime/${TS_RUNTIME_CLI_REL} --version 2>&1) || { echo "CLI_VERSION_FAILED:"$v; exit 6; }`,
    'echo "VERSION:$v"',
  ].join('\n');
}

/** The shell setup script: pinned tsx install into the owned volume (network bridge). */
function setupScript() {
  return [
    'set -e',
    'mkdir -p /tsruntime',
    'cd /tsruntime',
    `printf '{"name":"cleanup-smoke-tsruntime","private":true}' > package.json`,
    `npm install --no-audit --no-fund --prefix /tsruntime tsx@${TSX_VERSION} >/tmp/npm.log 2>&1 || { tail -40 /tmp/npm.log; exit 4; }`,
    'test -d /tsruntime/node_modules/@esbuild/linux-x64 || { echo "no linux-x64 esbuild"; exit 5; }',
    `printf '{"tsxVersion":"${TSX_VERSION}"}' > /tsruntime/${TS_RUNTIME_MARKER}`,
  ].join('\n');
}

/**
 * Run ONE owned, bounded runtime container (`create --cidfile` → verify
 * id+label → immutable prestart receipt → start → wait → logs → exact-id
 * removal). NEVER `--rm`. Never starts a failed create. Never removes by
 * name/prefix. Returns bounded raw stdout/stderr/status evidence per subcommand.
 *
 * `_inject` is a TEST-ONLY seam (`spawn`, `writeReceipt`) so the pure policy
 * controls can drive failed create/start/wait/log, owner mismatch, receipt
 * failure, timeout, nonzero-rm and generic-absence paths while importing the
 * ACTUAL source. In production `_inject` is null and the real primitives run.
 */
export function runOwnedContainer({
  kind = 'tsruntime',
  imageId,
  dockerArgs = [],
  command = [],
  waitTimeoutMs = RUNTIME_READY_WAIT_MS,
  receiptsDir,
  bound = RUNTIME_BOUND,
  runId: runIdIn = null,
  _inject = null,
} = {}) {
  const spawn = typeof _inject?.spawn === 'function' ? _inject.spawn : spawnSync;
  const runId = runIdIn ?? `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const containerName = `cleanup-smoke-tsruntime-${runId}`;
  const label = `${RUNTIME_RUN_LABEL_KEY}=${runId}`;
  const dir = receiptsDir ?? process.env.CLEANUP_SMOKE_RECEIPTS ?? join(tmpdir(), 'cleanup-smoke-receipts');
  mkdirSync(dir, { recursive: true });
  const prestartPath = join(dir, `${slugify(kind)}-${runId}.prestart.json`);
  const finalPath = join(dir, `${slugify(kind)}-${runId}.final.json`);

  const base = (over = {}) => ({
    ok: false, reason: null, kind, runId, containerName, label,
    image: imageId ?? null,
    containerId: null, containerCreated: false, containerStarted: false,
    containerTerminated: false, containerResidual: true, removalUnknown: true, removalDetail: null,
    exit: null, status: null, timedOut: false, setupError: true, elapsedMs: 0,
    out: '', err: '',
    prestartReceiptPath: null, finalReceiptPath: null,
    stream: { create: null, start: null, wait: null, logs: null, removal: null },
    ...over,
  });

  // Creation MUST use the exact full inspected image Id — a mutable tag alone is
  // not a runtime identity. Refuse before touching Docker.
  if (!RUNTIME_IMAGE_ID_RE.test(String(imageId))) {
    return base({ reason: 'image-id-unresolved', detail: 'container creation requires the exact full inspected image Id (sha256:…)' });
  }

  // Persist an immutable receipt via exclusive `wx`; a test seam may be injected
  // to drive the receipt-write-failure policy without touching the real FS.
  const writeReceipt = (path, obj) => {
    const text = JSON.stringify(obj, null, 2) + '\n';
    if (_inject && typeof _inject.writeReceipt === 'function') { _inject.writeReceipt(path, text); return; }
    writeFileSync(path, text, { flag: 'wx' });
  };

  const runTemp = mkdtempSync(join(tmpdir(), 'cleanup-smoke-tsruntime-'));
  const cidFile = join(runTemp, 'cid');
  const createRes = spawn(
    'docker',
    ['create', '--cidfile', cidFile, '--name', containerName, '--label', 'cleanup-smoke=1', '--label', label, ...dockerArgs, imageId, ...command],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: bound.create, killSignal: 'SIGKILL' },
  );

  // Durable --cidfile: the exact id is read from the file EVEN on a nonzero/failed
  // create, so a created container is never lost behind a stdout-only capture.
  let containerId = null;
  try {
    if (existsSync(cidFile)) containerId = readFileSync(cidFile, 'utf8').trim();
  } catch {
    containerId = null;
  }
  const idValid = typeof containerId === 'string' && CONTAINER_ID_RE.test(containerId);

  // A thrown removal transport must never bypass the receipt/result: convert it
  // into an UNKNOWN, fail-closed outcome. The canonical
  // `removeOwnedContainerById` implementation is unchanged — this only guards the
  // call site so a throw cannot skip the final receipt or the returned result.
  const safeRemove = () => {
    try { return removeOwnedContainerById(containerId, runId, bound, { spawn }); }
    catch (e) { return { removed: false, unknown: true, detail: `removal-threw(${e?.message ?? String(e)})` }; }
  };

  if (!idValid) {
    // A failed create with NO durable id is UNKNOWN, never "not-created".
    const stray = {
      schemaVersion: 1, kind, runId, containerName, containerId: null, label, image: imageId,
      createExit: createRes.status, unknown: true, createdAt: new Date().toISOString(),
      detail: 'create produced no readable cidfile — UNKNOWN (never not-created)',
      stderr: `${createRes.stderr ?? ''}`.slice(0, 400),
    };
    let pre = null;
    try { writeReceipt(prestartPath, stray); pre = prestartPath; } catch { pre = null; }
    return base({
      reason: 'create-unknown-no-cid', containerId: null, containerCreated: false,
      containerResidual: true, removalUnknown: true, removalDetail: 'unknown-no-cid',
      out: `${createRes.stdout ?? ''}`, err: `${createRes.stderr ?? ''}`,
      prestartReceiptPath: pre,
      stream: { create: statusObj(createRes), start: null, wait: null, logs: null, removal: null },
    });
  }

  // FAILED CREATE WITH A VALID ID: a container object exists but create did NOT
  // succeed — it must NEVER be started. Retain the prestart receipt, remove the
  // exact owned id, persist a final receipt.
  if (createRes.status !== 0) {
    const failedPrestart = {
      schemaVersion: 1, kind, runId, containerName, containerId, label, image: imageId,
      createExit: createRes.status, createFailed: true, started: false, createdAt: new Date().toISOString(),
    };
    let pre = null;
    try { writeReceipt(prestartPath, failedPrestart); pre = prestartPath; } catch { pre = null; }
    const removal = safeRemove();
    const failedFinal = { ...failedPrestart, removal, finishedAt: new Date().toISOString() };
    let fin = null;
    try { writeReceipt(finalPath, failedFinal); fin = finalPath; } catch { fin = null; }
    return base({
      reason: 'create-failed', containerId, containerCreated: true, containerStarted: false,
      containerTerminated: removal.removed, containerResidual: !removal.removed,
      removalUnknown: removal.unknown === true, removalDetail: removal.detail,
      out: `${createRes.stdout ?? ''}`, err: `${createRes.stderr ?? ''}`,
      prestartReceiptPath: pre, finalReceiptPath: fin,
      stream: { create: statusObj(createRes), start: null, wait: null, logs: null, removal },
    });
  }

  // Prove the exact newly recorded id and invocation label BEFORE start.
  const owner = spawn(
    'docker',
    ['inspect', '--format', `{{.Id}}|{{ index .Config.Labels "${RUNTIME_RUN_LABEL_KEY}" }}`, containerId],
    { encoding: 'utf8', windowsHide: true, timeout: bound.inspect, killSignal: 'SIGKILL' },
  );
  const ownership = {
    inspectExit: owner.status,
    raw: `${owner.stdout ?? ''}`.trim(),
    verified: owner.status === 0 && `${owner.stdout ?? ''}`.trim() === `${containerId}|${runId}`,
  };

  const prestartBase = {
    schemaVersion: 1, kind, runId, containerName, containerId, label, image: imageId,
    createdAt: new Date().toISOString(), ownership,
  };

  if (!ownership.verified) {
    // Record the observed (unverified) id before aborting — the exact id is
    // persisted and the container is NEVER started.
    let pre = null;
    try { writeReceipt(prestartPath, { ...prestartBase, ownershipVerified: false }); pre = prestartPath; } catch { pre = null; }
    // Ownership is not OURS: canonical removal re-inspects and refuses, so an
    // unverified object is never removed (and it is never started).
    const removal = safeRemove();
    // Persist a SEPARATE final receipt (when possible) documenting the refusal;
    // the immutable prestart receipt is never overwritten.
    const finalRec = { ...prestartBase, ownershipVerified: false, removal, finishedAt: new Date().toISOString() };
    let fin = null;
    try { writeReceipt(finalPath, finalRec); fin = finalPath; } catch { fin = null; }
    return base({
      reason: 'ownership-unverified', containerId, containerCreated: true, containerStarted: false,
      containerTerminated: removal.removed, containerResidual: !removal.removed,
      removalUnknown: removal.unknown === true, removalDetail: removal.detail,
      out: `${createRes.stdout ?? ''}`, err: `${createRes.stderr ?? ''}`,
      prestartReceiptPath: pre, finalReceiptPath: fin, ownership,
      stream: { create: statusObj(createRes), start: null, wait: null, logs: null, removal },
    });
  }

  // IMMUTABLE prestart receipt (recorded BEFORE start, exclusive `wx`). If it
  // cannot be written we FAIL CLOSED: remove the exact owned id and NEVER start.
  try {
    writeReceipt(prestartPath, prestartBase);
  } catch (e) {
    const removal = safeRemove();
    // Persist a SEPARATE final receipt (when possible) documenting the failure;
    // the (failed) prestart receipt is never overwritten and nothing is started.
    const finalRec = { ...prestartBase, prestartReceiptFailed: true, receiptError: e.message, removal, finishedAt: new Date().toISOString() };
    let fin = null;
    try { writeReceipt(finalPath, finalRec); fin = finalPath; } catch { fin = null; }
    return base({
      reason: 'prestart-receipt-failed', containerId, containerCreated: true, containerStarted: false,
      receiptError: e.message, containerTerminated: removal.removed, containerResidual: !removal.removed,
      removalUnknown: removal.unknown === true, removalDetail: removal.detail, ownership,
      prestartReceiptPath: null, finalReceiptPath: fin,
      stream: { create: statusObj(createRes), start: null, wait: null, logs: null, removal },
    });
  }

  let startRes = null;
  let waitRes = null;
  let logsRes = null;
  let removal;
  let thrownTransport = null;
  const started = Date.now();
  try {
    startRes = spawn('docker', ['start', containerId], { encoding: 'utf8', windowsHide: true, timeout: bound.start, killSignal: 'SIGKILL' });
    // Give the external Docker adapter a chance to close its raw frame; ETIMEDOUT still fails.
    if (startRes.status === 0) waitRes = spawn('docker', ['wait', containerId], { encoding: 'utf8', windowsHide: true, timeout: waitTimeoutMs, killSignal: 'SIGTERM' });
    logsRes = spawn('docker', ['logs', containerId], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: bound.logs, killSignal: 'SIGKILL' });
  } catch (e) {
    // A spawn that THROWS during start/wait/logs is a TRANSPORT failure: record it
    // and fall through to the still-required exact cleanup + separate final
    // result. It must not bypass the receipt or the fail-closed result.
    thrownTransport = e;
  } finally {
    // ALWAYS clean up the EXACT recorded id, on every path (a thrown transport and
    // a timeout included). safeRemove never throws.
    removal = safeRemove();
  }

  if (thrownTransport) {
    const elapsedMsThrown = Date.now() - started;
    const startFailed = !startRes || startRes.status !== 0;
    const finalRec = {
      ...prestartBase,
      startExit: startRes?.status ?? null, waitExit: waitRes?.status ?? null, logsExit: logsRes?.status ?? null,
      startFailed, timedOut: false, waitTransportOk: false, logsTransportOk: false,
      containerExit: null, elapsedMs: elapsedMsThrown,
      thrownTransportError: thrownTransport.message ?? String(thrownTransport),
      removal, finishedAt: new Date().toISOString(),
    };
    let finalWritten = null;
    try { writeReceipt(finalPath, finalRec); finalWritten = finalPath; } catch { finalWritten = null; }
    return base({
      ok: false, reason: 'transport-threw',
      containerId, containerCreated: true, containerStarted: !startFailed,
      containerTerminated: removal.removed, containerResidual: !removal.removed,
      removalUnknown: removal.unknown === true, removalDetail: removal.detail,
      exit: null, status: null, timedOut: false, setupError: true, elapsedMs: elapsedMsThrown,
      transportError: thrownTransport.message ?? String(thrownTransport),
      out: `${logsRes?.stdout ?? ''}`, err: `${logsRes?.stderr ?? ''}`, ownership,
      prestartReceiptPath: prestartPath, finalReceiptPath: finalWritten,
      stream: {
        create: statusObj(createRes), start: statusObj(startRes), wait: statusObj(waitRes),
        logs: logsRes
          ? { status: logsRes.status ?? null, stdout: `${logsRes.stdout ?? ''}`, stderr: `${logsRes.stderr ?? ''}`, error: logsRes.error?.code ?? null }
          : null,
        removal,
      },
    });
  }

  const elapsedMs = Date.now() - started;
  const startFailed = !startRes || startRes.status !== 0;
  const waitTransportOk = !!waitRes && waitRes.status === 0;
  const logsTransportOk = !!logsRes && logsRes.status === 0;
  // A killed `docker wait` CLI does NOT stop the container: a wait transport
  // timeout is never proof the subject terminated.
  const timedOut = waitRes?.error?.code === 'ETIMEDOUT' || (waitRes?.status === null && waitRes?.error != null);
  const rawExit = `${waitRes?.stdout ?? ''}`.trim();
  const exitCode = /^(?:0|[1-9][0-9]{0,2})$/.test(rawExit) && Number(rawExit) <= 255 ? Number(rawExit) : null;
  const out = `${logsRes?.stdout ?? ''}`;
  const err = `${logsRes?.stderr ?? ''}`;

  // SEPARATE final result — the immutable prestart receipt is never overwritten.
  const finalRec = {
    ...prestartBase,
    startExit: startRes?.status ?? null, waitExit: waitRes?.status ?? null, logsExit: logsRes?.status ?? null,
    startFailed, timedOut, waitTransportOk, logsTransportOk, containerExit: exitCode, elapsedMs,
    removal, finishedAt: new Date().toISOString(),
  };
  let finalWritten = null;
  try { writeReceipt(finalPath, finalRec); finalWritten = finalPath; } catch { finalWritten = null; }

  // Lifecycle health (transport + receipts + verified cleanup). The container's
  // OWN exit code is a separate, strictly parsed signal reported via `exit`.
  let reason = null;
  if (removal.removed !== true || removal.unknown === true) reason = 'cleanup-unverified';
  else if (startFailed) reason = 'start-failed';
  else if (timedOut) reason = 'wait-timeout';
  else if (!waitTransportOk) reason = 'wait-transport-failed';
  else if (exitCode === null) reason = 'no-definite-exit';
  else if (!logsTransportOk) reason = 'logs-unavailable';
  else if (finalWritten === null) reason = 'final-receipt-failed';
  const ok = reason === null;

  return base({
    ok, reason,
    containerId, containerCreated: true, containerStarted: !startFailed,
    containerTerminated: removal.removed, containerResidual: !removal.removed,
    removalUnknown: removal.unknown === true, removalDetail: removal.detail,
    exit: exitCode, status: exitCode, timedOut, setupError: !ok, elapsedMs,
    out, err, ownership,
    prestartReceiptPath: prestartPath, finalReceiptPath: finalWritten,
    stream: {
      create: statusObj(createRes), start: statusObj(startRes), wait: statusObj(waitRes),
      logs: { status: logsRes?.status ?? null, stdout: out, stderr: err, error: logsRes?.error?.code ?? null },
      removal,
    },
  });
}

/**
 * Parse the native tsx version from the probe output. The FIRST line after the
 * `VERSION:` marker must be EXACTLY `tsx v<semver>` (three numeric components,
 * no prefix/suffix/prerelease). A missing or duplicated marker, or an
 * unparseable line, is `version-malformed` (UNKNOWN); a well-formed but
 * DIFFERENT version is `version-mismatch` (a demonstrable incompleteness).
 */
export function parseNativeTsxVersion(out) {
  const text = `${out ?? ''}`;
  const markers = text.split('VERSION:').length - 1;
  if (markers === 0) return { ok: false, reason: 'version-malformed', detail: 'no VERSION: marker' };
  if (markers > 1) return { ok: false, reason: 'version-malformed', detail: 'duplicate VERSION: marker' };
  const rest = text.slice(text.indexOf('VERSION:') + 'VERSION:'.length);
  const firstLine = rest.split(/\r?\n/, 1)[0].replace(/[ \t\r]+$/, '');
  const m = /^tsx v(\d+\.\d+\.\d+)$/.exec(firstLine);
  if (!m) return { ok: false, reason: 'version-malformed', version: firstLine, detail: `unparseable native version line ${JSON.stringify(firstLine.slice(0, 80))}` };
  if (m[1] !== TSX_VERSION) return { ok: false, reason: 'version-mismatch', version: `tsx v${m[1]}` };
  return { ok: true, version: `tsx v${m[1]}` };
}

/**
 * Parse the marker JSON from the probe output. The line must PARSE (never a
 * substring grep) and carry an exact `tsxVersion` equal to the pinned version.
 * A missing line is `marker-missing`; malformed/duplicate/wrong-typed JSON is
 * `marker-invalid`; valid JSON with a DIFFERENT version is
 * `marker-version-mismatch`.
 */
export function parseMarkerVersion(out) {
  const text = `${out ?? ''}`;
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith('MARKER:'));
  if (lines.length === 0) return { ok: false, reason: 'marker-missing' };
  if (lines.length > 1) return { ok: false, reason: 'marker-invalid', detail: 'duplicate MARKER: line' };
  let obj;
  try { obj = JSON.parse(lines[0].slice('MARKER:'.length)); } catch { return { ok: false, reason: 'marker-invalid', detail: 'marker is not valid JSON' }; }
  if (!obj || typeof obj !== 'object' || typeof obj.tsxVersion !== 'string') return { ok: false, reason: 'marker-invalid', detail: 'marker tsxVersion missing/not a string' };
  if (obj.tsxVersion !== TSX_VERSION) return { ok: false, reason: 'marker-version-mismatch', version: obj.tsxVersion };
  return { ok: true, version: obj.tsxVersion };
}

/** Recognized explicit "missing component" probe tokens (emitted by our script). */
const PROBE_MISSING_TOKENS = [
  ['MARKER_MISSING', 'marker-missing'],
  ['CLI_MISSING', 'cli-missing'],
  ['ESBUILD_MISSING', 'esbuild-missing'],
];
function recognizedProbeToken(text) {
  const lines = `${text ?? ''}`.split(/\r?\n/).map((l) => l.trim());
  for (const [tok, reason] of PROBE_MISSING_TOKENS) if (lines.includes(tok)) return reason;
  return null;
}

/** Probe reasons that are DEMONSTRABLY incomplete (auto-repairable). Others refuse. */
export const REPAIRABLE_PROBE_REASONS = new Set(['marker-missing', 'marker-version-mismatch', 'cli-missing', 'esbuild-missing', 'version-mismatch']);

/**
 * Strict readiness probe. Returns
 * { ok, exists, owned, unknown, reason, version, detail, container, image }.
 * Never mutates the volume; a foreign/unowned volume is reported, not touched.
 * A failed probe TRANSPORT (or a residual container) is `unknown:true` — never
 * evidence that the setup is incomplete. A definite nonzero probe exit is only
 * demonstrably-incomplete when it names an explicitly recognized missing
 * marker/CLI/esbuild; any OTHER exit, and any malformed/unparseable marker or
 * native version, is UNKNOWN and refuses rewrite. `receiptsDir` is threaded into
 * the probe container so its receipts live beside the caller's.
 */
export function tsRuntimeProbe(volume = TS_RUNTIME_VOLUME, opts = {}) {
  const deps = opts._inject ?? {};
  const spawn = deps.spawn ?? spawnSync;

  const vol = inspectRuntimeVolume(volume, { spawn });
  if (vol.unknown) return { ok: false, exists: false, owned: false, unknown: true, reason: 'volume-inspect-unknown', detail: vol.detail };
  if (!vol.exists) return { ok: false, exists: false, owned: false, unknown: false, reason: 'volume-missing' };
  if (vol.name !== volume) return { ok: false, exists: true, owned: false, unknown: false, reason: 'volume-name-mismatch', name: vol.name };
  if (vol.label !== OWNERSHIP_LABEL_VALUE) return { ok: false, exists: true, owned: false, unknown: false, reason: 'unowned-volume', ownership: vol.label };

  const img = opts.imageId
    ? { ok: true, id: opts.imageId, reference: opts.image ?? RUNTIME_IMAGE, unknown: false }
    : resolveRuntimeImage(opts.image ?? RUNTIME_IMAGE, { spawn });
  if (!img.ok) {
    return { ok: false, exists: true, owned: true, unknown: img.unknown === true, reason: img.unknown ? 'image-inspect-unknown' : 'image-absent', detail: img.detail };
  }

  const run = runOwnedContainer({
    kind: 'tsruntime-probe', imageId: img.id,
    dockerArgs: ['--network', 'none', '--mount', `type=volume,src=${volume},dst=/tsruntime,readonly`],
    command: ['sh', '-lc', probeScript()], waitTimeoutMs: RUNTIME_READY_WAIT_MS,
    receiptsDir: opts.receiptsDir, _inject: deps,
  });

  if (run.containerResidual) return { ok: false, exists: true, owned: true, unknown: true, reason: 'probe-container-residual', detail: run.removalDetail, container: run, image: img };
  if (!run.ok) {
    if (run.timedOut) return { ok: false, exists: true, owned: true, unknown: true, reason: 'probe-timeout', detail: run.reason, container: run, image: img };
    if (run.exit === null) return { ok: false, exists: true, owned: true, unknown: true, reason: 'probe-transport-failed', detail: run.reason, container: run, image: img };
    // The container lifecycle was not fully verified (transport/receipt/cleanup):
    // any captured exit is NOT trustworthy content-level evidence — UNKNOWN.
    return { ok: false, exists: true, owned: true, unknown: true, reason: 'probe-lifecycle-unverified', exit: run.exit, detail: run.reason, container: run, image: img };
  }
  if (run.exit !== 0) {
    // Lifecycle FULLY verified AND a definite nonzero exit: demonstrably incomplete
    // ONLY when the probe named an explicitly recognized missing marker/CLI/esbuild.
    const token = recognizedProbeToken(`${run.out}${run.err}`);
    if (token) {
      return { ok: false, exists: true, owned: true, unknown: false, reason: token, exit: run.exit, detail: `${run.out}${run.err}`.trim().slice(-300), container: run, image: img };
    }
    // Any other command/error exit is UNKNOWN — never permission to rewrite.
    return { ok: false, exists: true, owned: true, unknown: true, reason: 'probe-incomplete-unknown', exit: run.exit, detail: `${run.out}${run.err}`.trim().slice(-300), container: run, image: img };
  }
  // Exit 0: PARSE the marker JSON and the native version exactly. A missing,
  // malformed or unparseable value is UNKNOWN and refuses rewrite; only a VALID
  // known marker/version mismatch is demonstrably incomplete.
  const marker = parseMarkerVersion(run.out);
  if (!marker.ok) {
    if (marker.reason === 'marker-version-mismatch') {
      return { ok: false, exists: true, owned: true, unknown: false, reason: 'marker-version-mismatch', markerVersion: marker.version, detail: `marker tsxVersion=${JSON.stringify(marker.version)} expected ${TSX_VERSION}`, container: run, image: img };
    }
    return { ok: false, exists: true, owned: true, unknown: true, reason: marker.reason, detail: `${run.out}`.slice(-300), container: run, image: img };
  }
  const native = parseNativeTsxVersion(run.out);
  if (!native.ok) {
    if (native.reason === 'version-mismatch') {
      return { ok: false, exists: true, owned: true, unknown: false, reason: 'version-mismatch', version: native.version, detail: `expected tsx v${TSX_VERSION}`, container: run, image: img };
    }
    return { ok: false, exists: true, owned: true, unknown: true, reason: native.reason, detail: native.detail ?? 'native tsx version not parsable', container: run, image: img };
  }
  return { ok: true, exists: true, owned: true, unknown: false, reason: null, version: native.version, container: run, image: img };
}

export function tsRuntimeReady(volume = TS_RUNTIME_VOLUME, opts = {}) {
  return tsRuntimeProbe(volume, opts).ok === true;
}

/**
 * Ensure the Linux-native tsx runtime volume exists. Only OUR owned volume may be
 * (re)built; an existing unowned/unknown volume is refused and left untouched.
 * The setup container is created/owned/verified and uses the exact inspected
 * image Id; the bridge network is used ONLY by that pinned tsx install.
 *
 * Accepts EITHER the round-22 `reference` option OR the earlier `image` option
 * and normalizes ONCE; the resolved full image Id is then used for BOTH the setup
 * and the readiness probe. `receiptsDir` is threaded into the probe as well.
 */
export function provisionTsRuntime({ volume = TS_RUNTIME_VOLUME, reference, image, _inject = null, receiptsDir = undefined, waitTimeoutMs = RUNTIME_SETUP_WAIT_MS } = {}) {
  // Normalize legacy `image` and current `reference` to ONE reference, resolved to
  // the exact full image Id a single time.
  const referenceIn = reference ?? image ?? RUNTIME_IMAGE;
  const deps = _inject ?? {};
  const spawn = deps.spawn ?? spawnSync;

  if (!dockerAvailability(spawn, deps)) return { ok: false, reason: 'docker-unavailable', volume, cliRel: TS_RUNTIME_CLI_REL };

  const vol = inspectRuntimeVolume(volume, { spawn });
  if (vol.unknown) return { ok: false, reason: 'volume-inspect-unknown', volume, detail: vol.detail, unknown: true, cliRel: TS_RUNTIME_CLI_REL };

  const img = resolveRuntimeImage(referenceIn, { spawn });
  if (!img.ok) {
    return { ok: false, reason: img.unknown ? 'image-inspect-unknown' : 'image-absent', volume, detail: img.detail, unknown: img.unknown === true, cliRel: TS_RUNTIME_CLI_REL };
  }

  let repairEvidence = null;
  if (vol.exists) {
    if (vol.name !== volume) return { ok: false, reason: 'volume-name-mismatch', volume, name: vol.name, cliRel: TS_RUNTIME_CLI_REL };
    if (vol.label !== OWNERSHIP_LABEL_VALUE) {
      return {
        ok: false, reason: 'unowned-volume-refusing', volume, ownership: vol.label,
        detail: 'existing volume lacks our ownership label; refusing to mutate/rebuild/delete', cliRel: TS_RUNTIME_CLI_REL,
      };
    }
    const probe = tsRuntimeProbe(volume, { _inject: deps, imageId: img.id, image: referenceIn, receiptsDir });
    if (probe.ok) {
      return { ok: true, built: false, reused: true, repaired: false, volume, cliRel: TS_RUNTIME_CLI_REL, tsxVersion: TSX_VERSION, version: probe.version, image: img, probe };
    }
    // An existing owned volume whose state is UNCERTAIN refuses automatic repair;
    // a failed probe TRANSPORT never grants permission to rewrite.
    if (probe.unknown === true) {
      return { ok: false, reason: 'owned-volume-uncertain-refusing-repair', volume, probe, detail: `owned volume state is uncertain (${probe.reason}); refusing automatic repair`, cliRel: TS_RUNTIME_CLI_REL };
    }
    // ONLY an explicitly identified missing marker/CLI/esbuild or a VALID known
    // marker/version mismatch is demonstrably incomplete; anything else refuses.
    if (!REPAIRABLE_PROBE_REASONS.has(probe.reason)) {
      return { ok: false, reason: 'owned-volume-refusing-repair', volume, probe, detail: `owned volume is not demonstrably incomplete (${probe.reason}); refusing automatic repair`, cliRel: TS_RUNTIME_CLI_REL };
    }
    // Demonstrably incomplete OWN setup: repair, with the exact ownership label
    // and this explicit evidence recorded.
    repairEvidence = { ownership: vol.label, probeReason: probe.reason, probeExit: probe.exit ?? null, detail: probe.detail ?? null };
  } else {
    const create = spawn('docker', ['volume', 'create', '--label', `${OWNERSHIP_LABEL_KEY}=${OWNERSHIP_LABEL_VALUE}`, volume], {
      encoding: 'utf8', windowsHide: true, timeout: RUNTIME_BOUND.volume, killSignal: 'SIGKILL',
    });
    if (create.status !== 0) {
      const msg = `${create.stderr ?? ''}${create.error?.code ? ` (${create.error.code})` : ''}`.trim();
      return { ok: false, reason: 'volume-create-failed', volume, detail: msg.slice(0, 300), unknown: true, cliRel: TS_RUNTIME_CLI_REL };
    }
    // Verify the EXACT volume name AND ownership label BEFORE any writable setup.
    const recheck = inspectRuntimeVolume(volume, { spawn });
    if (recheck.unknown || recheck.exists !== true || recheck.name !== volume || recheck.label !== OWNERSHIP_LABEL_VALUE) {
      return {
        ok: false, reason: 'volume-ownership-unverified', volume,
        detail: recheck.unknown ? 'volume inspect unknown after create' : `name=${JSON.stringify(recheck.name ?? null)} label=${JSON.stringify(recheck.label ?? null)}`,
        unknown: recheck.unknown === true, cliRel: TS_RUNTIME_CLI_REL,
      };
    }
  }

  const run = runOwnedContainer({
    kind: 'tsruntime-setup', imageId: img.id,
    dockerArgs: ['--network', 'bridge', '--mount', `type=volume,src=${volume},dst=/tsruntime`],
    command: ['sh', '-lc', setupScript()], waitTimeoutMs, receiptsDir, _inject: deps,
  });
  if (run.containerResidual) {
    return { ok: false, reason: 'setup-container-residual', volume, detail: run.removalDetail, container: run, image: img, cliRel: TS_RUNTIME_CLI_REL };
  }
  if (!run.ok || run.exit !== 0) {
    return {
      ok: false,
      reason: run.timedOut ? 'setup-timeout' : 'ts-runtime-provision-failed',
      volume,
      detail: `${run.out}${run.err}`.trim().slice(-600),
      exit: run.exit, container: run, image: img, unknown: run.exit === null, cliRel: TS_RUNTIME_CLI_REL,
    };
  }

  // Same resolved image Id as the setup; probe the SAME reference, sharing receiptsDir.
  const probe = tsRuntimeProbe(volume, { _inject: deps, imageId: img.id, image: referenceIn, receiptsDir });
  return {
    ok: probe.ok === true,
    built: repairEvidence === null,
    repaired: repairEvidence !== null,
    reused: false,
    volume, cliRel: TS_RUNTIME_CLI_REL, tsxVersion: TSX_VERSION,
    version: probe.version ?? null, image: img, probe,
    ...(repairEvidence ? { repairEvidence } : {}),
  };
}
