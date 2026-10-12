/**
 * CleanUp1 §6.2 — genuine execution isolation for the script smoke.
 *
 * The first scaffold sanitized proxies and stripped credentials, which does NOT
 * stop Node `net`/`pg`/child tools (five adverse probes reproduced that). This
 * module runs every entry point inside a container with a hard, kernel-enforced
 * boundary instead:
 *
 *   --network none    no interface at all: any connect()/DNS fails (ENETUNREACH,
 *                     EAI_AGAIN). Nothing can reach the host network.
 *   --read-only       the container root is read-only AND the repo is bind
 *                     mounted `readonly`, so any write to the tree fails EROFS.
 *                     Only /tmp (tmpfs) and the disposable /evidence mount are
 *                     writable.
 *   -e ...            the host environment is NOT inherited; only NODE_ENV/CI
 *                     are set, so every credential is absent by construction.
 *
 * If Docker is not available the runner FAILS CLOSED (`isolation-unavailable`).
 * It never silently falls back to executing an arbitrary script on the host.
 *
 * This module also records a `denials` SIGNAL — a regex hit for a denial errno
 * in the container's stdout/stderr. That is a HEURISTIC, not an audit: a script
 * that CATCHES the denial and exits cleanly emits no such text, so the signal
 * reports no attempt. The genuine denied-syscall/attempt audit (which observes
 * the syscalls under strace and therefore sees caught/suppressed attempts) lives
 * in attempt-audit.mjs; run that for a real attempted-access record. The
 * `denials` signal remains only as a fast first-pass hint and is never claimed
 * to be an audit.
 *
 * TIMEOUT vs SETUP (round-46): `timedOut` is set ONLY for a DEFINITE wait
 * deadline — the bounded `docker wait` CLI killed by its own timeout
 * (`error.code === 'ETIMEDOUT'`). That is reported as a fail-closed `timeout`,
 * NOT a setup-incompatibility. Every OTHER wait TRANSPORT failure (ENOENT, a
 * killed CLI without the timeout code, a bare spawn error), an unavailable
 * `docker logs`, a failed `docker start`, a missing tool/module in the logs, a
 * missing/unwritable receipt, or an UNKNOWN/non-definite removal stays a
 * fail-closed SETUP/cleanup failure. No exit code is ever synthesised, and a
 * deadline NEVER masks a real missing-tool/start/logs/removal failure.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { validateInvocationContext, nativeCwdFor, normalizeRel } from './invocation-context.mjs';

export const ISOLATION_IMAGE = process.env.CLEANUP_SMOKE_IMAGE ?? 'node:22-alpine';
/** tsx is an apps/api dependency; run it from there (its real JS entry, not the shell shim). */
const TSX_CLI_REL = 'apps/api/node_modules/tsx/dist/cli.mjs';

/**
 * The tsx flag that binds a specific committed tsconfig. tsx otherwise resolves
 * its tsconfig from the CURRENT WORKING DIRECTORY — and this runner executes the
 * subject with `cwd=/src`, where the committed app `tsconfig.json` (which turns on
 * `experimentalDecorators`/`emitDecoratorMetadata` for Nest-decorated source) is
 * NOT found. The subject is therefore invoked with an explicit
 * `--tsconfig <committed path>` so the exact committed source-app config governs
 * the transform. The flag is threaded into native argv, the trace proof and the
 * receipt provenance (never a fabricated capability).
 */
export const TSX_TSCONFIG_FLAG = '--tsconfig';
/** Script extensions that require the tsx loader (and therefore a committed tsconfig). */
export const TS_SCRIPT_RE = /\.(ts|mts|cts)$/i;

/** Normalize a repo-relative step path to POSIX form (drops a leading `./`). */
function toPosixRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** True iff a repo-relative subject path is contained (not absolute, no drive, no `..`). */
export function subjectRelContained(rel) {
  const r = toPosixRel(rel);
  if (!r || r.startsWith('/') || /^[A-Za-z]:/.test(r)) return false;
  return !r.split('/').some((s) => s === '..');
}

/**
 * Select the COMMITTED `tsconfig.json` that governs a subject by walking UP from
 * the subject's own directory to the repo root and taking the NEAREST real
 * `tsconfig.json`. The walk only ASCENDS, so it never crosses into a sibling app:
 * an API config can never be applied to an unrelated app's subject, and no config
 * is ever invented. A `.ts`/`.mts`/`.cts` subject with NO committed config on its
 * chain FAILS CLOSED (`tsconfig-absent`) — the isolated tsx is never allowed to
 * run decorated app source without its committed config.
 *
 * Fail-closed cases: an absolute/escaping subject path; a nearest candidate that
 * is a symlink, not a regular file, resolves OUTSIDE the repo real path, or is not
 * a JSON object with a `compilerOptions` object. Non-TS subjects are
 * `applicable:false` (no loader, no config).
 *
 * `fs` is an injectable seam (`existsSync`/`lstatSync`/`realpathSync`/`readFileSync`
 * and optionally `sep`) so pure controls can drive every branch with no disk I/O.
 */
export function selectSourceAppTsConfig(repoRoot, rel, { fs = null } = {}) {
  const f = { existsSync, lstatSync, realpathSync, readFileSync, sep, ...(fs ?? {}) };
  const r = toPosixRel(rel);
  if (!TS_SCRIPT_RE.test(r)) return { ok: true, applicable: false, configRel: null };
  if (!subjectRelContained(r)) {
    return {
      ok: false, applicable: true, configRel: null, reason: 'subject-path-unsafe',
      detail: `subject rel is absolute or escaping: ${r}`,
    };
  }
  let rootReal;
  try {
    rootReal = f.realpathSync(repoRoot);
  } catch (e) {
    return { ok: false, applicable: true, configRel: null, reason: 'repo-root-unresolved', detail: String(e?.message ?? e) };
  }
  const segs = r.split('/');
  for (let i = segs.length - 1; i >= 0; i--) {
    const dirRel = segs.slice(0, i).join('/');
    const cfgRel = dirRel ? `${dirRel}/tsconfig.json` : 'tsconfig.json';
    const abs = join(repoRoot, ...cfgRel.split('/'));
    if (!f.existsSync(abs)) continue;
    let lst;
    try {
      lst = f.lstatSync(abs);
    } catch (e) {
      return { ok: false, applicable: true, configRel: null, reason: 'tsconfig-unreadable', detail: `${cfgRel}: ${e?.message ?? e}` };
    }
    if (lst.isSymbolicLink()) return { ok: false, applicable: true, configRel: null, reason: 'tsconfig-symlink', detail: cfgRel };
    if (!lst.isFile()) return { ok: false, applicable: true, configRel: null, reason: 'tsconfig-not-file', detail: cfgRel };
    let real;
    try {
      real = f.realpathSync(abs);
    } catch (e) {
      return { ok: false, applicable: true, configRel: null, reason: 'tsconfig-unreadable', detail: `${cfgRel}: ${e?.message ?? e}` };
    }
    if (real !== rootReal && !real.startsWith(rootReal + f.sep)) {
      return { ok: false, applicable: true, configRel: null, reason: 'tsconfig-escaping', detail: `${cfgRel} -> ${real}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(f.readFileSync(abs, 'utf8'));
    } catch {
      return { ok: false, applicable: true, configRel: null, reason: 'tsconfig-invalid', detail: `${cfgRel} is not valid JSON` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.compilerOptions || typeof parsed.compilerOptions !== 'object') {
      return { ok: false, applicable: true, configRel: null, reason: 'tsconfig-invalid', detail: `${cfgRel} lacks a compilerOptions object` };
    }
    return { ok: true, applicable: true, configRel: cfgRel };
  }
  return {
    ok: false, applicable: true, configRel: null, reason: 'tsconfig-absent',
    detail: `no committed tsconfig.json on the source-app chain for ${r}`,
  };
}

const NET_DENY =
  /ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EADDRNOTAVAIL|getaddrinfo|network is unreachable|connect EBADF/i;
const WRITE_DENY = /EROFS|read-only file system|EACCES|Operation not permitted|EBADF/i;

function posix(p) {
  let x = String(p).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\//.exec(x);
  if (drive) x = '/' + drive[1].toLowerCase() + '/' + x.slice(3);
  return x.replace(/\/+$/, '');
}
function joinPosix(...parts) {
  return parts
    .map((p, i) => (i === 0 ? posix(p) : String(p).replace(/\\/g, '/').replace(/^\/+/, '')))
    .join('/');
}
function dirOfRel(rel) {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '.' : rel.slice(0, i);
}

export function dockerAvailable() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    killSignal: 'SIGKILL',
  });
  return r.status === 0;
}

export function imagePresent(image = ISOLATION_IMAGE) {
  const r = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', windowsHide: true, timeout: 15000, killSignal: 'SIGKILL' });
  return r.status === 0;
}

export function sourceIdentity(repoRoot, rel) {
  try {
    const sha256 = createHash('sha256').update(readFileSync(join(repoRoot, rel))).digest('hex');
    return { path: rel, sha256 };
  } catch {
    return { path: rel, sha256: null };
  }
}

/**
 * Run one entry point in the isolated container.
 *
 * The container is given an OWNED identity (`--name` + unique
 * `cleanup-smoke.run=<runId>` label) and is NEVER `--rm`-managed: `docker create`
 * records the exact container id BEFORE start, then bounded `docker start` /
 * `docker wait` run it. A killed `docker wait` CLI does NOT stop the container, so
 * removal targets the EXACT recorded id and only after verifying its
 * `cleanup-smoke.run` label (never by name/prefix), then verifies it is gone.
 * `containerTerminated` / `containerResidual` report that; a residual container is
 * a fail-closed condition.
 *
 * @returns {{status:number|null, exit:number|null, signal:null, elapsedMs:number,
 *   out:string, err:string, timedOut:boolean, spawnError?:string,
 *   denials:{network:boolean, write:boolean}, evidenceDir:string,
 *   source:object, sandbox:string, containerName:string, containerId:string|null,
 *   containerCreated:boolean, containerTerminated:boolean, containerResidual:boolean,
 *   removalDetail:string}}
 */
export function runIsolated({
  repoRoot,
  rel,
  args = [],
  timeoutMs = 30000,
  evidenceDir,
  image = ISOLATION_IMAGE,
  requireWritableEvidence = false,
  wrapper = null,
  extraDockerArgs = [],
  tsRuntime = null,
  subjectDeps = null,
  invocationContext = undefined,
  _inject = null,
} = {}) {
  // Test-only seam: a pure replacement for the docker spawn primitive and the
  // prestart-receipt writer, so lifecycle POLICY controls can drive failed
  // create/start/rm/daemon-unknown paths while importing the ACTUAL source. In
  // production `_inject` is null and the real primitives are used unchanged.
  const spawn = (typeof _inject?.spawn === 'function' ? _inject.spawn : spawnSync);
  const native = posix(repoRoot);
  const evHost = evidenceDir ?? mkdtempSync(join(tmpdir(), 'cleanup-smoke-evidence-'));
  mkdirSync(evHost, { recursive: true });

  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const containerName = `cleanup-smoke-${runId}`;

  // OPTIONAL canonical invocation context. `undefined` keeps the LEGACY behavior
  // for the not-yet-migrated callers (default argv/lifecycle unchanged). An
  // EXPLICIT context — including `null` — MUST match a FRESHLY derived canonical
  // plan: a stale/forged/wrong-subject/partial-reference/unknown-cwd context is
  // REFUSED before any Docker create. The caller's free-form cwd/key is never
  // trusted, no command text is executed and no declaration flag (--commit …) is
  // ever replayed.
  const refuseContext = (reason, detail) => ({
    status: null, exit: null, signal: null, elapsedMs: 0, out: '',
    err: `invocation context refused: ${reason}${detail ? ` (${detail})` : ''}`,
    timedOut: false, setupError: true, contextError: reason, invocationContextRejected: true,
    denials: { network: false, write: false }, evidenceDir: evHost, source: sourceIdentity(repoRoot, rel),
    sandbox: `docker ${image} --network none --read-only`,
    containerName, containerId: null, containerCreated: false,
    containerTerminated: false, containerResidual: true, removalDetail: 'context-refused', removalUnknown: true,
    prestartReceiptPath: null, finalReceiptPath: null, requireWritableEvidence,
    nativeArgv: ['node', String(rel).replace(/\\/g, '/'), ...args],
    runtimeConfig: null, runtimeConfigRel: null, tsxLoader: null, runtimeConfigError: null,
    invocationContext: null, contextKey: null, nativeCwd: null, nativeSubject: null, workingDirInspect: null,
  });
  let ctxBinding = null;
  if (invocationContext !== undefined) {
    const v = validateInvocationContext(invocationContext, repoRoot);
    if (!v.ok) return refuseContext(v.reason, v.detail);
    if (normalizeRel(v.context.rel) !== normalizeRel(rel)) {
      return refuseContext('context-subject-mismatch', `${v.context.rel} != ${String(rel).replace(/\\/g, '/')}`);
    }
    ctxBinding = v.context;
  }
  let workingDirInspect = null;

  const relPosix = String(rel).replace(/\\/g, '/');
  const isTs = TS_SCRIPT_RE.test(rel);
  const usingVolume = !!(subjectDeps && subjectDeps.volume);
  const isContextBound = ctxBinding !== null;
  // A context-bound invocation selects the declaration's effective cwd. The
  // SUBJECT and (for TS) the tsx LOADER are ABSOLUTE so `chdir` can never change
  // which code executes; the legacy path keeps its exact (relative) argv.
  const nativeCwd = isContextBound ? nativeCwdFor(ctxBinding.cwdRel, { mountedVolume: usingVolume, nativeRoot: repoRoot }) : null;
  const nativeSubject = isContextBound ? (usingVolume ? `/src/${relPosix}` : joinPosix(native, relPosix)) : null;
  const subjectToken = isContextBound ? nativeSubject : relPosix;
  const tsxCli = isContextBound
    ? usingVolume
      ? `/src/${TSX_CLI_REL}` // ABSOLUTE volume loader → independent of the selected cwd
      : tsRuntime && tsRuntime.cliRel
        ? `/tsruntime/${tsRuntime.cliRel}`
        : joinPosix(native, TSX_CLI_REL)
    : subjectDeps && subjectDeps.volume
      ? TSX_CLI_REL // legacy relative → resolves under the read-only /src workspace topology
      : tsRuntime && tsRuntime.cliRel
        ? `/tsruntime/${tsRuntime.cliRel}`
        : joinPosix(native, TSX_CLI_REL);

  // A `.ts` subject MUST receive the EXACT committed source-app tsconfig: the
  // isolated tsx otherwise resolves a tsconfig from cwd=/src (where the committed
  // app config is not found) and drops `experimentalDecorators`. The selection is
  // fail-closed (absent/wrong/escaping config => refuse, never run with a
  // fabricated/default capability). Non-TS subjects carry no loader and no config.
  const configSel = selectSourceAppTsConfig(repoRoot, rel);
  if (isTs && (!configSel.ok || !configSel.configRel)) {
    const reason = configSel.reason ?? 'tsconfig-absent';
    return {
      status: null, exit: null, signal: null, elapsedMs: 0, out: '',
      err: `runtime config refused: ${reason}${configSel.detail ? ` (${configSel.detail})` : ''}`,
      timedOut: false, setupError: true, runtimeConfigError: reason,
      denials: { network: false, write: false }, evidenceDir: evHost, source: sourceIdentity(repoRoot, rel),
      sandbox: `docker ${image} --network none --read-only`,
      containerName, containerId: null, containerCreated: false,
      containerTerminated: false, containerResidual: true, removalDetail: 'tsconfig-refused', removalUnknown: true,
      prestartReceiptPath: null, finalReceiptPath: null, requireWritableEvidence,
      nativeArgv: ['node', tsxCli, subjectToken, ...args],
      runtimeConfig: null, runtimeConfigRel: null, tsxLoader: tsxCli, runtimeConfigError: reason,
      invocationContext: ctxBinding, contextKey: ctxBinding ? ctxBinding.contextKey : null,
      nativeCwd, nativeSubject, workingDirInspect: null,
    };
  }
  const configPath = configSel.configRel
    ? (subjectDeps && subjectDeps.volume ? `/src/${configSel.configRel}` : joinPosix(native, configSel.configRel))
    : null;
  // The container command: node [tsxCli --tsconfig <committedconfig>] <rel> [args].
  // Every subject argument is preserved byte-for-byte and in order.
  const command = ['node'];
  if (isTs) {
    command.push(tsxCli, TSX_TSCONFIG_FLAG, configPath);
  }
  command.push(subjectToken);
  command.push(...args);
  // Runtime-config provenance: threaded into native argv, the trace proof and
  // every receipt (a null config is the honest "no loader / no config" case).
  const runtime = {
    runtimeConfig: configPath,
    runtimeConfigRel: configSel.configRel ?? null,
    tsxLoader: isTs ? tsxCli : null,
    runtimeConfigError: null,
  };

  // A subjectDeps volume is trusted ONLY with verified context (root native owns
  // provisioning). An unverified/arbitrary volume fails closed — never mounted.
  if (subjectDeps && !(subjectDeps.completed === true && subjectDeps.volume && subjectDeps.verifiedLabel === true)) {
    return {
      status: null, exit: null, signal: null, elapsedMs: 0, out: '',
      err: 'subjectDeps not verified (requires a completed volume with a verified owner label)', timedOut: false, setupError: true,
      denials: { network: false, write: false }, evidenceDir: evHost, source: sourceIdentity(repoRoot, rel),
      sandbox: `docker ${image} --network none --read-only`,
      containerName, containerId: null, containerCreated: false,
      containerTerminated: false, containerResidual: true, removalDetail: 'unverified-subjectdeps', removalUnknown: true,
      prestartReceiptPath: null, finalReceiptPath: null, requireWritableEvidence, nativeArgv: command,
      invocationContext: ctxBinding, contextKey: ctxBinding ? ctxBinding.contextKey : null,
      nativeCwd, nativeSubject, workingDirInspect: null,
      ...runtime,
    };
  }

  // `docker create` (does NOT start) with a UNIQUE invocation label; the exact
  // container id is captured from create's stdout and RECORDED BEFORE start, so
  // cleanup can target the exact id — never a name/prefix.
  const createArgv = [
    'create',
    '--name', containerName,
    '--label', 'cleanup-smoke=1', '--label', `cleanup-smoke.run=${runId}`,
    '--network', 'none', '--read-only', '--tmpfs', '/tmp:exec,size=64m',
    '--mount', `type=bind,src=${repoRoot},dst=${native},readonly`,
    '--mount', `type=bind,src=${evHost},dst=/evidence`,
    ...(tsRuntime && tsRuntime.volume ? ['--mount', `type=volume,src=${tsRuntime.volume},dst=/tsruntime,readonly`] : []),
    // A verified owned SUBJECT-DEPS volume: the complete workspace topology
    // (source + real node_modules with app-relative symlinks + pnpm store),
    // mounted READ-ONLY at /src. Subjects run FROM that topology (cwd=/src) so
    // real ESM imports resolve — never NODE_PATH or a tsx-only shim.
    ...(subjectDeps && subjectDeps.volume ? ['--mount', `type=volume,src=${subjectDeps.volume},dst=/src,readonly`] : []),
    '-w', isContextBound ? nativeCwd : usingVolume ? '/src' : native,
    '-e', 'NODE_ENV=test', '-e', 'CI=1', '-e', 'CLEANUP_SMOKE_ISOLATED=1',
    ...extraDockerArgs,
    image,
    ...(wrapper ? wrapper : []),
    ...command,
  ];
  const BOUND = { create: 30000, start: 20000, logs: 15000, inspect: 10000, rm: 15000 };
  const runTemp = mkdtempSync(join(tmpdir(), 'cleanup-smoke-run-'));
  const cidFile = join(runTemp, 'cid');
  const receiptsDir = process.env.CLEANUP_SMOKE_RECEIPTS ?? join(tmpdir(), 'cleanup-smoke-receipts');
  mkdirSync(receiptsDir, { recursive: true });
  const prestartPath = join(receiptsDir, `${runId}.prestart.json`);
  const finalPath = join(receiptsDir, `${runId}.final.json`);

  // Durable --cidfile: the exact id is read from the file EVEN on a nonzero/failed
  // create, so a created container is never lost behind a stdout-only capture.
  const created = spawn('docker', ['create', '--cidfile', cidFile, ...createArgv.slice(1)], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: BOUND.create, killSignal: 'SIGKILL',
  });
  let containerId = null;
  try {
    if (existsSync(cidFile)) containerId = readFileSync(cidFile, 'utf8').trim();
  } catch {
    containerId = null;
  }
  const idValid = typeof containerId === 'string' && /^[0-9a-f]{64}$/.test(containerId);

  // Persist an immutable receipt via exclusive `wx`; a test seam may be injected
  // to drive the receipt-write-failure policy without touching the real FS.
  const writePrestart = (path, obj) => {
    const text = JSON.stringify(obj, null, 2) + '\n';
    if (_inject && typeof _inject.writePrestart === 'function') { _inject.writePrestart(path, text); return; }
    writeFileSync(path, text, { flag: 'wx' });
  };

  if (!idValid) {
    // A failed create with NO durable receipt is UNKNOWN, never "not-created".
    const stray = { schemaVersion: 1, runId, containerName, containerId: null, label: `cleanup-smoke.run=${runId}`,
      subject: rel, modeArgs: args, image, createExit: created.status, unknown: true,
      detail: 'create failed with no readable cidfile — UNKNOWN', stderr: `${created.stderr ?? ''}`.slice(0, 400) };
    let prestartWritten = null;
    try { writePrestart(prestartPath, stray); prestartWritten = prestartPath; } catch { prestartWritten = null; }
    return {
      status: null, exit: null, signal: null, elapsedMs: 0,
      out: `${created.stdout ?? ''}`, err: `${created.stderr ?? ''}`,
      timedOut: false, setupError: true,
      ...(created.error?.message ? { spawnError: created.error.message } : {}),
      denials: { network: false, write: false }, evidenceDir: evHost, source: sourceIdentity(repoRoot, rel),
      sandbox: `docker ${image} --network none --read-only`,
      containerName, containerId: null, containerCreated: false,
      containerTerminated: false, containerResidual: true, removalDetail: 'unknown-no-cid', removalUnknown: true,
      prestartReceiptPath: prestartWritten, finalReceiptPath: null,
      requireWritableEvidence, nativeArgv: command,
      invocationContext: ctxBinding, contextKey: ctxBinding ? ctxBinding.contextKey : null,
      nativeCwd, nativeSubject, workingDirInspect,
      ...runtime,
    };
  }

  // FAILED CREATE WITH A VALID CID: `docker create` did NOT succeed (nonzero exit)
  // yet a durable id WAS recorded, so a container object exists. It must NEVER be
  // started. Retain the immutable prestart receipt, then remove the exact owned
  // id+label (ownership-checked, definite absence) on the fail-closed path.
  if (created.status !== 0) {
    const failedPrestart = {
      schemaVersion: 1, runId, containerName, containerId, label: `cleanup-smoke.run=${runId}`,
      subject: rel, modeArgs: args, image, source: sourceIdentity(repoRoot, rel), evidenceDir: evHost,
      createdAt: new Date().toISOString(), createExit: created.status, createFailed: true, started: false,
    };
    let prestartWritten = null;
    try { writePrestart(prestartPath, failedPrestart); prestartWritten = prestartPath; } catch { prestartWritten = null; }
    const removal = removeOwnedContainerById(containerId, runId, BOUND, { spawn });
    const failedFinal = { ...failedPrestart, removal, finishedAt: new Date().toISOString() };
    let finalWritten = null;
    try { writePrestart(finalPath, failedFinal); finalWritten = finalPath; } catch { finalWritten = null; }
    return {
      status: null, exit: null, signal: null, elapsedMs: 0,
      out: `${created.stdout ?? ''}`, err: `${created.stderr ?? ''}`,
      timedOut: false, setupError: true, createExit: created.status, containerStarted: false, createFailed: true,
      ...(created.error?.message ? { spawnError: created.error.message } : {}),
      denials: { network: false, write: false }, evidenceDir: evHost, source: failedPrestart.source,
      sandbox: `docker ${image} --network none --read-only`,
      containerName, containerId, containerCreated: true,
      containerTerminated: removal.removed, containerResidual: !removal.removed,
      removalDetail: removal.detail, removalUnknown: removal.unknown === true,
      prestartReceiptPath: prestartWritten, finalReceiptPath: finalWritten,
      requireWritableEvidence, nativeArgv: command,
      invocationContext: ctxBinding, contextKey: ctxBinding ? ctxBinding.contextKey : null,
      nativeCwd, nativeSubject, workingDirInspect,
      ...runtime,
    };
  }

  // Prove the exact newly recorded id and invocation label BEFORE start.
  const owner = spawn('docker', ['inspect', '--format', '{{.Id}}|{{ index .Config.Labels "cleanup-smoke.run" }}', containerId], { encoding: 'utf8', windowsHide: true, timeout: BOUND.inspect, killSignal: 'SIGKILL' });
  const ownership = { inspectExit: owner.status, raw: `${owner.stdout ?? ''}`.trim(), verified: owner.status === 0 && `${owner.stdout ?? ''}`.trim() === `${containerId}|${runId}` };
  if (!ownership.verified) {
    const removal = removeOwnedContainerById(containerId, runId, BOUND, { spawn });
    return {
      status: null, exit: null, signal: null, elapsedMs: 0, out: '', err: 'created container ownership could not be verified before start', timedOut: false, setupError: true,
      denials: { network: false, write: false }, evidenceDir: evHost, source: sourceIdentity(repoRoot, rel),
      sandbox: `docker ${image} --network none --read-only`, containerName, containerId,
      containerCreated: true, containerStarted: false, containerTerminated: removal.removed, containerResidual: !removal.removed,
      removalDetail: removal.detail, removalUnknown: removal.unknown === true, ownership,
      prestartReceiptPath: null, finalReceiptPath: null, requireWritableEvidence, nativeArgv: command,
      invocationContext: ctxBinding, contextKey: ctxBinding ? ctxBinding.contextKey : null,
      nativeCwd, nativeSubject, workingDirInspect,
      ...runtime,
    };
  }

  // CONTEXT-BOUND WORKING-DIR PROOF. Before starting a context-bound child,
  // inspect the EXACT owned CID's actual `.Config.WorkingDir`, parse its JSON
  // string and require equality to the expected native cwd. An argv/hash claim
  // alone does not prove `chdir`. A malformed/missing/foreign/wrong-cwd/
  // inspect-transport result is a fail-closed SETUP failure: NEVER start, always
  // attempt the existing exact-owner-checked cleanup (the valid exact id/label
  // must not block removal just because the cwd proof is bad). The inspection
  // bytes/status/exact id/context binding are retained in the immutable receipts.
  if (isContextBound) {
    const wdRes = spawn('docker', ['inspect', '--format', '{{json .Config.WorkingDir}}', containerId], {
      encoding: 'utf8', windowsHide: true, timeout: BOUND.inspect, killSignal: 'SIGKILL',
    });
    // LOSSLESS capture: keep Docker's EXACT stdout/stderr bytes — including its
    // trailing newline — plus SHA-256 and byte counts, and the transport
    // exit/signal/error. The parsed/trimmed fields are retained ONLY as
    // backward-compatible conveniences; nothing about the raw inspection is lost.
    const wdStdout =
      typeof wdRes?.stdout === 'string' ? wdRes.stdout : Buffer.isBuffer(wdRes?.stdout) ? wdRes.stdout.toString('utf8') : `${wdRes?.stdout ?? ''}`;
    const wdStderr =
      typeof wdRes?.stderr === 'string' ? wdRes.stderr : Buffer.isBuffer(wdRes?.stderr) ? wdRes.stderr.toString('utf8') : `${wdRes?.stderr ?? ''}`;
    const wdRaw = wdStdout.trim();
    let wdParsed = null;
    let parseOk = false;
    try {
      const val = JSON.parse(wdRaw);
      if (typeof val === 'string') {
        wdParsed = val;
        parseOk = true;
      }
    } catch {
      parseOk = false;
    }
    const wdVerified =
      !!wdRes && wdRes.status === 0 && !wdRes.error && !wdRes.signal && parseOk && wdParsed === nativeCwd;
    workingDirInspect = {
      inspectExit: wdRes?.status ?? null,
      inspectSignal: wdRes?.signal ?? null,
      inspectError: wdRes?.error ? String(wdRes.error.message ?? wdRes.error.code ?? wdRes.error) : null,
      // Lossless inspection bytes + integrity metadata (trailing newline preserved).
      stdoutRaw: wdStdout,
      stderrRaw: wdStderr,
      stdoutSha256: createHash('sha256').update(Buffer.from(wdStdout, 'utf8')).digest('hex'),
      stderrSha256: createHash('sha256').update(Buffer.from(wdStderr, 'utf8')).digest('hex'),
      stdoutBytes: Buffer.byteLength(wdStdout, 'utf8'),
      stderrBytes: Buffer.byteLength(wdStderr, 'utf8'),
      // Compatibility (parsed / trimmed) conveniences retained unchanged.
      raw: wdRaw,
      parsed: wdParsed,
      expected: nativeCwd,
      verified: wdVerified,
      parseOk,
      exactContainerId: containerId,
      contextKey: ctxBinding.contextKey,
      reason: wdVerified
        ? null
        : !wdRes || wdRes.status !== 0 || wdRes.error || wdRes.signal
          ? 'inspect-transport'
          : !parseOk
            ? 'inspect-malformed'
            : 'working-dir-mismatch',
    };
    if (!wdVerified) {
      const wdFail = {
        schemaVersion: 1, runId, containerName, containerId, label: `cleanup-smoke.run=${runId}`,
        subject: rel, modeArgs: args, image, source: sourceIdentity(repoRoot, rel), evidenceDir: evHost,
        runtimeConfig: runtime.runtimeConfig, runtimeConfigRel: runtime.runtimeConfigRel, tsxLoader: runtime.tsxLoader,
        invocationContext: ctxBinding, contextKey: ctxBinding.contextKey, nativeCwd, nativeSubject,
        workingDirInspect, createdAt: new Date().toISOString(), ownership,
        setupError: true, workingDirFailed: true, started: false,
      };
      let prestartWritten = null;
      try { writePrestart(prestartPath, wdFail); prestartWritten = prestartPath; } catch { prestartWritten = null; }
      const removal = removeOwnedContainerById(containerId, runId, BOUND, { spawn });
      const wdFinal = { ...wdFail, removal, finishedAt: new Date().toISOString() };
      let finalWritten = null;
      try { writePrestart(finalPath, wdFinal); finalWritten = finalPath; } catch { finalWritten = null; }
      return {
        status: null, exit: null, signal: null, elapsedMs: 0, out: '',
        err: `working-dir proof refused: ${workingDirInspect.reason}${workingDirInspect.raw ? ` (${workingDirInspect.raw})` : ''}`,
        timedOut: false, setupError: true, workingDirError: workingDirInspect.reason,
        denials: { network: false, write: false }, evidenceDir: evHost, source: sourceIdentity(repoRoot, rel),
        sandbox: `docker ${image} --network none --read-only`, containerName, containerId,
        containerCreated: true, containerStarted: false, containerTerminated: removal.removed, containerResidual: !removal.removed,
        removalDetail: removal.detail, removalUnknown: removal.unknown === true, ownership, workingDirInspect,
        prestartReceiptPath: prestartWritten, finalReceiptPath: finalWritten, requireWritableEvidence, nativeArgv: command,
        invocationContext: ctxBinding, contextKey: ctxBinding.contextKey, nativeCwd, nativeSubject,
        ...runtime,
      };
    }
  }

  // IMMUTABLE prestart receipt (recorded BEFORE start, exclusive `wx`). If it cannot
  // be written we FAIL CLOSED: remove the exact owned id and NEVER start.
  const prestart = {
    schemaVersion: 1, runId, containerName, containerId, label: `cleanup-smoke.run=${runId}`,
    subject: rel, modeArgs: args, image, source: sourceIdentity(repoRoot, rel), evidenceDir: evHost,
    runtimeConfig: runtime.runtimeConfig, runtimeConfigRel: runtime.runtimeConfigRel, tsxLoader: runtime.tsxLoader,
    invocationContext: ctxBinding, contextKey: ctxBinding ? ctxBinding.contextKey : null,
    nativeCwd, nativeSubject, workingDirInspect,
    createdAt: new Date().toISOString(), ownership,
  };
  try {
    writePrestart(prestartPath, prestart);
  } catch (e) {
    const removal = removeOwnedContainerById(containerId, runId, BOUND, { spawn });
    return {
      status: null, exit: null, signal: null, elapsedMs: 0, out: '', err: `prestart receipt failed: ${e.message}`,
      timedOut: false, setupError: true, denials: { network: false, write: false },
      evidenceDir: evHost, source: prestart.source,
      sandbox: `docker ${image} --network none --read-only`,
      containerName, containerId, containerCreated: true,
      containerTerminated: removal.removed, containerResidual: !removal.removed,
      removalDetail: removal.detail, removalUnknown: removal.unknown === true,
      prestartReceiptPath: null, finalReceiptPath: null, receiptError: e.message,
      requireWritableEvidence, nativeArgv: command,
      invocationContext: ctxBinding, contextKey: ctxBinding ? ctxBinding.contextKey : null,
      nativeCwd, nativeSubject, workingDirInspect,
      ...runtime,
    };
  }

  let startRes;
  let waitRes;
  let logs;
  let removal;
  const started = Date.now();
  try {
    startRes = spawn('docker', ['start', containerId], { encoding: 'utf8', windowsHide: true, timeout: BOUND.start, killSignal: 'SIGKILL' });
    // Give the external Docker adapter a chance to close its raw frame; ETIMEDOUT still fails.
    waitRes = spawn('docker', ['wait', containerId], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, killSignal: 'SIGTERM' });
    logs = spawn('docker', ['logs', containerId], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: BOUND.logs, killSignal: 'SIGKILL' });
  } finally {
    // ALWAYS clean up the EXACT recorded id, on every path (timeout included).
    removal = removeOwnedContainerById(containerId, runId, BOUND, { spawn });
  }
  // Lifecycle statuses are CHECKED, not assumed. A start that never succeeded
  // means the entry point never ran; a logs read that timed out/errored means the
  // captured output is incomplete. Both are fail-closed setup conditions.
  const startFailed = !startRes || startRes.status !== 0;
  const logsUnavailable = !logs || logs.status !== 0;
  const elapsedMs = Date.now() - started;
  const out = `${logs?.stdout ?? ''}`;
  const err = `${logs?.stderr ?? ''}`;
  // A DEFINITE wait deadline — the bounded `docker wait` CLI was killed by its
  // OWN timeout (`error.code === 'ETIMEDOUT'`) — is a real TIMEOUT. Every OTHER
  // null/errored wait transport (ENOENT, a killed CLI without the timeout code, a
  // bare spawn error) is a fail-closed SETUP/transport failure, NEVER silently
  // relabelled a timeout. Only the definite deadline sets `timedOut`.
  const waitDeadline = waitRes?.error?.code === 'ETIMEDOUT';
  const timedOut = waitDeadline;
  const waitUnavailable = !waitRes || (waitRes.status !== 0 && !waitDeadline);
  const rawExitCode = `${waitRes?.stdout ?? ''}`.trim();
  const exitCode = /^(?:0|[1-9][0-9]{0,2})$/.test(rawExitCode) && Number(rawExitCode) <= 255 ? Number(rawExitCode) : null;

  const combined = `${out}\n${err}`;
  // A missing tool/module (e.g. tsx) or unavailable loader is a SETUP
  // INCOMPATIBILITY of the isolated runtime — never a silent pass. A failed
  // `docker start`, an unavailable `docker logs`, a non-deadline wait transport
  // error and a non-definite exit (never synthesised) are likewise fail-closed.
  // The ONLY case excluded from the setup gap is the definite deadline, which is
  // its OWN (still failing) `timeout` outcome — but a missing tool, a failed
  // start/logs, or a non-deadline transport error STILL fails closed even when a
  // deadline is present.
  const moduleUnavailable =
    /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNSUPPORTED|exec format error|no such file or directory/i.test(
      combined,
    );
  let setupError =
    startFailed ||
    logsUnavailable ||
    waitUnavailable ||
    moduleUnavailable ||
    (exitCode === null && !timedOut);

  // SEPARATE final result — the immutable prestart receipt is never overwritten.
  const finalRec = {
    ...prestart, startExit: startRes?.status ?? null, waitExit: waitRes?.status ?? null,
    logsExit: logs?.status ?? null, startFailed, logsUnavailable, waitUnavailable, waitDeadline,
    containerExit: Number.isInteger(exitCode) ? exitCode : null, timedOut, removal, finishedAt: new Date().toISOString(),
  };
  let finalWritten = null;
  try { writePrestart(finalPath, finalRec); finalWritten = finalPath; } catch { finalWritten = null; setupError = true; }

  return {
    status: Number.isInteger(exitCode) ? exitCode : null,
    exit: Number.isInteger(exitCode) ? exitCode : null,
    signal: null,
    elapsedMs,
    out,
    err,
    timedOut,
    setupError,
    ...(startRes?.error?.message ? { spawnError: startRes.error.message } : {}),
    denials: {
      network: !timedOut && NET_DENY.test(combined),
      write: !timedOut && WRITE_DENY.test(combined),
    },
    evidenceDir: evHost,
    source: prestart.source,
    sandbox: `docker ${image} --network none --read-only (+/tmp tmpfs, +/evidence rw)${wrapper ? ` [wrapped: ${wrapper[0]}]` : ''}`,
    containerName,
    containerId,
    containerCreated: true,
    containerTerminated: removal.removed,
    containerResidual: !removal.removed,
    removalDetail: removal.detail,
    removalUnknown: removal.unknown === true,
    prestartReceiptPath: prestartPath,
    finalReceiptPath: finalWritten,
    requireWritableEvidence,
    nativeArgv: command,
    invocationContext: ctxBinding,
    contextKey: ctxBinding ? ctxBinding.contextKey : null,
    nativeCwd,
    nativeSubject,
    workingDirInspect,
    ...runtime,
  };
}

/**
 * Remove a container keyed by its EXACT recorded id, and ONLY when its exact
 * `cleanup-smoke.run` label matches the expected run id. Never removes by
 * name/prefix. An inspect error (daemon unavailable / timeout) is UNKNOWN — NOT
 * proof of absence — and fails closed with `unknown:true`. Removal must be
 * verified: the id must be re-inspected and produce a SINGLE, fully-anchored
 * Docker absence diagnostic naming that EXACT 64-hex id (see
 * `bindsExactContainerAbsence`); a diagnostic that merely MENTIONS the id, names
 * ANOTHER id, carries SUFFIX text, is accompanied by other diagnostics, or is a
 * transport error is UNKNOWN.
 */
export function removeOwnedContainerById(containerId, expectedRunId, bound = {}, deps = {}) {
  const spawn = (typeof deps.spawn === 'function' ? deps.spawn : spawnSync);
  const t = { inspect: bound.inspect ?? 10000, rm: bound.rm ?? 15000 };
  if (!/^[0-9a-f]{64}$/.test(String(containerId))) return { removed: false, unknown: true, detail: 'no-recorded-id' };
  const ins = spawn(
    'docker',
    ['inspect', '--format', '{{.Id}}|{{ index .Config.Labels "cleanup-smoke.run" }}', containerId],
    { encoding: 'utf8', windowsHide: true, timeout: t.inspect, killSignal: 'SIGKILL' },
  );
  if (ins.status !== 0 || ins.error || ins.signal) {
    return { removed: false, unknown: true, detail: `inspect-failed(${`${ins.stderr ?? ''}${ins.error?.message ?? ''}`.trim().slice(0, 120)})` };
  }
  const [id, label] = `${ins.stdout ?? ''}`.trim().split('|');
  if (id !== containerId) return { removed: false, unknown: false, detail: `id-mismatch(${JSON.stringify(id)})` };
  if (label !== expectedRunId) return { removed: false, unknown: false, detail: `ownership-mismatch(label=${JSON.stringify(label)})` };
  const rm = spawn('docker', ['rm', '-f', containerId], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: t.rm, killSignal: 'SIGKILL' });
  // Removal is proven ONLY by rm exit 0 AND a definite absence diagnostic bound to
  // the FULL exact requested 64-hex id — never a generic "not found", never a
  // short-id prefix/suffix, never a message that merely MENTIONS the id, never
  // more than one diagnostic, and never a daemon/timeout transport error.
  if (rm.status !== 0 || rm.error || rm.signal) return { removed: false, unknown: true, detail: `rm-exit-${rm.status}(${`${rm.stderr ?? ''}`.trim().slice(0, 120)})` };
  const check = spawn('docker', ['inspect', '--format', '{{.Id}}', containerId], { encoding: 'utf8', windowsHide: true, timeout: t.inspect, killSignal: 'SIGKILL' });
  if (check.status === 0) return { removed: false, unknown: false, detail: 'still-present' };
  // A killed/timed-out/failed CLI (spawn error) is a TRANSPORT failure — it is
  // NOT proof the container is gone, whatever its stderr happened to say.
  if (check.error || check.signal || !Number.isInteger(check.status) || check.status < 1 || check.status > 255 || String(check.stdout ?? '').trim() !== '') {
    return { removed: false, unknown: true, detail: `absence-transport(${`${check.error?.code ?? check.error?.message ?? check.signal ?? `exit=${check.status}`}`.trim().slice(0, 120)})` };
  }
  const msg = `${check.stderr ?? ''}`;
  if (bindsExactContainerAbsence(msg, containerId)) return { removed: true, unknown: false, detail: 'removed' };
  return { removed: false, unknown: true, detail: `absence-unknown(${msg.trim().slice(0, 120)})` };
}

/**
 * True ONLY when `msg` is a single, fully-anchored Docker absence diagnostic that
 * binds the EXACT complete requested 64-hex container id — the container analogue
 * of the exact-name binding used for volumes/images
 * (ts-runtime `msgBindsExactAbsence`).
 *
 * Recognized forms (the WHOLE trimmed message, nothing more):
 *   - `No such container: <id>`
 *   - `No such object: <id>`
 *   - either with an optional `Error:` / `Error response from daemon:` prefix.
 *
 * Because the match is anchored to the ENTIRE message and the captured id must
 * equal the requested id EXACTLY, a message that only MENTIONS the id elsewhere,
 * names ANOTHER id, carries SUFFIX text (`<id>-x`), or contains MULTIPLE
 * diagnostics is NOT accepted. Containers are Docker objects, so the engine's
 * inspect diagnostic uses the "object" noun; the older "container" noun is
 * accepted too.
 */
export function bindsExactContainerAbsence(msg, containerId) {
  if (!/^[0-9a-f]{64}$/.test(String(containerId))) return false;
  const text = String(msg ?? '').trim();
  if (/[\r\n]/.test(text)) return false;
  const m = /^(?:Error(?: response from daemon)?:\s*)?No such (?:container|object):\s*(\S+)\s*$/i.exec(text);
  return !!m && m[1] === containerId;
}
