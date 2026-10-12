/**
 * CleanUp1 §6.2 — runtime-plan (tsconfig/loader) integration controls.
 *
 * These exercise the REAL emitter/validator helpers on OWNED synthetic source + raw
 * strace fixtures — never an imitation validator:
 *
 *   - the ONE canonical `selectSourceAppTsConfig` (source config selection);
 *   - the ONE canonical `entrypointExecutedFromTrace` / `parseSyscallTrace` (attempt
 *     audit) driven with the INDEPENDENTLY-derived expected runtime plan;
 *   - `expectedRuntimePlanFor` (run-smoke) vs `expectedSmokeRuntimeFor` (gate);
 *   - the REAL emitter `toEvidenceResult` (threads the plan into the raw record);
 *   - the REAL `validateSmokeEvidence` through its NORMAL `ctx.root` discovery path
 *     (NO `smokeScope()` seam bypass): a correct TS app-config-bound native-bind
 *     record is ACCEPTED with ZERO validator problems, while a wrong-app / missing /
 *     changed config, a forged loader, extra argv and a non-TS unexpected-plan record
 *     are REJECTED. A changed committed config/file byte invalidates old evidence.
 *   - producer/gate fingerprint-spec parity over the SAME discovered subject set.
 *
 * SCOPE HONESTY: every fixture here is a PURE OWNED SYNTHETIC control fixture — it is
 * never native acceptance and never substitutes for the remote native run. Raw bytes
 * live under the owned live-evidence root of a throwaway synthetic repo.
 *
 * Usage:
 *   node scripts/cleanup-script-smoke/runtime-evidence-controls.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSourceAppTsConfig } from './isolation.mjs';
import { parseSyscallTrace, entrypointExecutedFromTrace, readAndParseTraceFileSync } from './attempt-audit.mjs';
import { planInvocationContexts, nativeCwdFor, normalizeRel } from './invocation-context.mjs';
import { SMOKE_TSX_LOADER_REL, expectedRuntimePlanFor, smokeOneContext, aggregateContexts } from './run-smoke.mjs';
import { smokeFingerprintSpecs, selectedConfigSpecs, declarationManifestSpecs, toEvidenceResult } from './emit-evidence.mjs';
import {
  canonicalSmokeSpecs,
  canonicalSmokeSubjects,
  expectedSmokeRuntimeFor,
  resolveExpectedSmokeScope,
  validateSmokeEvidence,
  SMOKE_EVIDENCE_SCHEMA,
  SMOKE_EVIDENCE_VERSION,
  TS_RUNTIME_BOUND_LOADER,
} from '../cleanup-gates/lib/smoke-evidence.mjs';
import { TS_RUNTIME_CLI_REL } from './ts-runtime.mjs';
import { deriveContract, contractFor, MISSING_DATABASE_URL_SMOKE_CONTEXT as CONSUMER_CONTEXT } from '../cleanup-gates/lib/script-contract.mjs';
import { MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';
import { discoverEntrypoints } from './discover.mjs';
import { contextEvidenceChecks } from './context-evidence-controls.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

const UNKNOWN_FLAG = '--cleanup-smoke-unknown-flag';

/** A contained executable entrypoint with a REAL documented no-args + --help branch. */
const ENTRY_SRC = [
  'const args = process.argv.slice(2);',
  "if (args.length === 0) { console.error('usage: x <file>'); process.exit(2); }",
  "if (args.includes('--help')) { console.log('usage: x <file>'); process.exit(0); }",
  '',
].join('\n');

/** Build a synthetic repo with a committed app tsconfig + a TS subject + a non-TS subject. */
function syntheticRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-rte-'));
  writeRootManifests(root);
  mkdirSync(join(root, 'apps', 'api', 'scripts'), { recursive: true });
  // The root `scripts/` fixture directory MUST exist before writing its subject.
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'apps', 'api', 'tsconfig.json'), JSON.stringify({ compilerOptions: { experimentalDecorators: true } }, null, 2) + '\n');
  writeFileSync(join(root, 'apps', 'api', 'scripts', 'x.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'scripts', 'y.mjs'), 'export const y = 1;\n');
  return root;
}

/** A successful strace execve line for `node [<loader> --tsconfig <cfg>] <subject> <args>`. */
function execveLine(loader, cfg, subject, args = []) {
  const toks = ['node', ...(loader ? [loader] : []), ...(cfg ? ['--tsconfig', cfg] : []), subject, ...args];
  return `execve("/usr/bin/node", [${toks.map((t) => `"${t}"`).join(', ')}], 0x0) = 0\n`;
}

// ───────────────────────── REAL-validator synthetic fixture ─────────────────────────
// A correct TS app-config-bound record MUST be ACCEPTED (zero problems) through the
// validator's NORMAL ctx.root discovery path; every mutation MUST be REJECTED.

const sha256buf = (b) => createHash('sha256').update(b).digest('hex');
const sha256file = (p) => sha256buf(readFileSync(p));

/** POSIX form of a host path — byte-identical to smoke-evidence.mjs's posixHostPath. */
function posixHost(p) {
  let x = String(p).replace(/\\/g, '/');
  const d = /^([A-Za-z]):\//.exec(x);
  if (d) x = `/${d[1].toLowerCase()}/${x.slice(3)}`;
  return x.replace(/\/+$/, '');
}

/** A control-only fingerprint over the canonical smoke spec BYTES (subjects + config). */
function synthFingerprint(root) {
  const h = createHash('sha256');
  for (const s of canonicalSmokeSpecs(root)) {
    h.update(s + '\0');
    const abs = join(root, s);
    try { if (statSync(abs).isFile()) h.update(readFileSync(abs)); } catch { /* tooling dir is not a file */ }
    h.update('\0');
  }
  return h.digest('hex');
}

/** Build the synthetic context through the NORMAL ctx.root discovery path (NO seam). */
function synthCtx(root) {
  const contained = (rel) => {
    const abs = resolve(root, rel);
    return abs === root || abs.startsWith(root + sep);
  };
  return {
    root,
    resolve: (p) => resolve(root, p),
    existsSync: (p) => { try { statSync(p); return true; } catch { return false; } },
    sha256File: (p) => sha256file(p),
    readFile: (p) => readFileSync(p, 'utf8'),
    readAndParseTraceFileSync: (abs) => readAndParseTraceFileSync(abs),
    commitExists: () => true,
    isAncestorOfHead: () => true,
    fingerprintAlgorithm: 'sha256-fixture-v1',
    fingerprintAt: () => ({ ok: true, fingerprint: synthFingerprint(root) }),
    // Honest existence: a spec that is NOT actually present at the recorded source is
    // reported absent (no trust-only "exists" claim for a required missing manifest).
    specExistsAtCommit: (_sha, p) => { try { statSync(join(root, p)); return true; } catch { return false; } },
    contractFor: (p) => deriveContract(readFileSync(join(root, p), 'utf8'), p),
    sourceShaAt: (p) => sha256file(join(root, p)),
    trackedAndClean: () => ({ tracked: true, clean: true }),
    contained,
    // The raw fixture bytes live under the owned live-evidence root of the synthetic repo.
    evidenceMode: 'owned-live-runtime',
    // The controlled native-bind topology (installed-checkout default): the loader is
    // the EXACT allowlisted `/tsruntime/<TS_RUNTIME_CLI_REL>` derived from the committed
    // ts-runtime constant — never picked from an untrusted invocation self-report.
    nativeTopology: { mode: 'native-bind', tsRuntimeCliRel: TS_RUNTIME_CLI_REL },
  };
}

/** The honest root/workspace manifests a strengthened (packageJsons-bound) contract
 *  requires: a real root `package.json` (NO scripts — it must not invent declared
 *  commands) plus a real `pnpm-workspace.yaml`. */
function writeRootManifests(root) {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cleanup-rte-synthetic-fixture', private: true }, null, 2) + '\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - scripts\n');
  // The canonical smoke TOOLING spec (`scripts/cleanup-script-smoke`) is always part
  // of the measured scope; a real (empty) directory keeps the strengthened honest
  // existence check satisfied rather than claiming a nonexistent input exists.
  mkdirSync(join(root, 'scripts', 'cleanup-script-smoke'), { recursive: true });
}

function acceptanceRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-rte-acc-'));
  writeRootManifests(root);
  mkdirSync(join(root, 'apps', 'api', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'apps', 'api', 'tsconfig.json'), JSON.stringify({ compilerOptions: { experimentalDecorators: true } }, null, 2) + '\n');
  writeFileSync(join(root, 'apps', 'api', 'scripts', 'x.ts'), ENTRY_SRC);
  writeFileSync(join(root, 'scripts', 'y.mjs'), ENTRY_SRC);
  return root;
}

/**
 * Build a synthetic v5 evidence artifact with the REAL emitter (`toEvidenceResult`)
 * over the CANONICAL contexts of each subject, with overridable per-subject runtime
 * plans. `opts.tsRuntime` / `opts.jsRuntime` override the bound plan fields;
 * `opts.noArgsExtra` appends an unexpected token to the TS subject's no-args argv
 * AND trace.
 */
function buildSynthArtifact(root, opts = {}) {
  const problems = [];
  const used = new Set();
  const commitSha = 'a'.repeat(40);
  const relDir = 'docs/plans/cleanup1-script-smoke-live/run-1/';
  // The owned live-evidence directory must exist before any raw fixture byte is
  // written beneath it (the real harness creates its output dir up front).
  mkdirSync(join(root, relDir), { recursive: true });
  const native = posixHost(root);
  const configRel = 'apps/api/tsconfig.json';
  const CID = 'c'.repeat(64);
  const defaultTs = {
    runtimeConfig: `${native}/${configRel}`, runtimeConfigRel: configRel,
    tsxLoader: TS_RUNTIME_BOUND_LOADER, runtimeContext: 'native-bind',
  };
  const defaultJs = { runtimeConfig: null, runtimeConfigRel: null, tsxLoader: null, runtimeContext: 'none' };
  const subjects = canonicalSmokeSubjects(root);
  const plan = planInvocationContexts(root);
  const results = [];
  const rawLogHashes = {};
  const contract = { noArgs: { exit: 2, usagePrinted: true }, help: { supported: true, exit: 0, usagePrinted: true } };
  const M_ARGS = { noArgs: [], help: ['--help'], unknown: ['--cleanup-smoke-unknown-flag'] };
  const sha256OfText = (s) => createHash('sha256').update(Buffer.from(String(s), 'utf8')).digest('hex');

  for (const s of subjects) {
    const slug = s.path.replace(/[^A-Za-z0-9._-]+/g, '__');
    const isTs = /\.(ts|mts|cts)$/i.test(s.path);
    const runtime = isTs ? { ...defaultTs, ...(opts.tsRuntime ?? {}) } : { ...defaultJs, ...(opts.jsRuntime ?? {}) };
    const canonCtxs = plan.contexts.filter((c) => c.rel === s.path);
    const ev = mkdtempSync(join(tmpdir(), 'cleanup-rte-ev-'));
    const sourceSha = sha256file(join(root, s.path));
    const contextResults = [];
    let ctxIndex = 0;
    for (const c of canonCtxs) {
      const i = ctxIndex++;
      const nativeCwd = c.cwdRel && c.cwdRel !== '.' ? `${native}/${c.cwdRel}` : native;
      const nativeSubject = `${native}/${c.rel}`;
      const wdRaw = JSON.stringify(nativeCwd) + '\n';
      const wdInspect = {
        inspectExit: 0, inspectSignal: null, inspectError: null,
        stdoutRaw: wdRaw, stderrRaw: '', stdoutSha256: sha256OfText(wdRaw), stderrSha256: sha256OfText(''), stdoutBytes: Buffer.byteLength(wdRaw, 'utf8'), stderrBytes: 0,
        // The ACTUAL producer shape: `raw` is the EXACT `stdoutRaw.trim()` — the JSON
        // string literal `"<cwd>"` (quotes included), NOT the decoded path.
        raw: wdRaw.trim(), parsed: nativeCwd, expected: nativeCwd, verified: true, parseOk: true,
        exactContainerId: CID, contextKey: c.contextKey, reason: null,
      };
      const tokens = (mode) => {
        const extra = isTs && opts.noArgsExtra && mode === 'noArgs' ? ['--extra'] : [];
        return ['node', ...(runtime.tsxLoader ? [runtime.tsxLoader] : []), ...(runtime.runtimeConfig ? ['--tsconfig', runtime.runtimeConfig] : []), nativeSubject, ...M_ARGS[mode], ...extra];
      };
      const cslug = `${slug}.ctx${i}`;
      const invs = {};
      for (const mode of ['noArgs', 'help', 'unknown']) {
        writeFileSync(join(ev, `${cslug}.${mode}.trace`), `1234 execve("/usr/bin/node", [${tokens(mode).map((t) => `"${t}"`).join(', ')}], 0x0) = 0\n`);
        // Unique, per-mode/context inconclusive-safe identities.
        const modeExit = mode === 'help' ? 0 : 2;
        const cid = createHash('sha256').update(`cid|${s.path}|${c.contextKey}|${mode}`).digest('hex');
        const wdInspectMode = { ...wdInspect, exactContainerId: cid };
        const runId = `run-${mode}-${i}-${slug}`;
        const createdMs = Date.now() - 2000;
        // The COMPLETE ACTUAL producer prestart shape (isolation.mjs): schemaVersion,
        // runId, containerName, containerId, label, subject, modeArgs, image, source,
        // evidenceDir, runtimeConfig/runtimeConfigRel/tsxLoader, invocationContext,
        // contextKey, nativeCwd, nativeSubject, workingDirInspect, createdAt, ownership.
        const pre = {
          schemaVersion: 1, runId, containerName: `cleanup-smoke-${runId}`, containerId: cid, label: `cleanup-smoke.run=${runId}`,
          subject: s.path, modeArgs: M_ARGS[mode], image: 'cleanup-smoke-audit:fixture',
          source: { path: s.path, sha256: sourceSha }, evidenceDir: ev,
          runtimeConfig: runtime.runtimeConfig, runtimeConfigRel: runtime.runtimeConfigRel, tsxLoader: runtime.tsxLoader,
          invocationContext: c, contextKey: c.contextKey, nativeCwd, nativeSubject, workingDirInspect: wdInspectMode,
          createdAt: new Date(createdMs).toISOString(),
          ownership: { inspectExit: 0, raw: `${cid}|${runId}`, verified: true },
        };
        // The ACTUAL producer final-receipt shape: the prestart fields spread, then
        // startExit/waitExit/logsExit/startFailed/logsUnavailable/waitUnavailable/
        // waitDeadline/containerExit/timedOut/removal/finishedAt. There is NO
        // `started:true` field in the real producer — a successful start is proven
        // by a finite successful start/wait/log transport plus a finite containerExit.
        const fin = { ...pre, startExit: 0, waitExit: 0, logsExit: 0, startFailed: false, logsUnavailable: false, waitUnavailable: false, waitDeadline: false, containerExit: modeExit, timedOut: false, removal: { removed: true, unknown: false, detail: 'removed' }, finishedAt: new Date(createdMs + 1000).toISOString() };
        // The ORIGINAL receipt bytes live under the owned SOURCE evidence dir (ev);
        // the emitter copies them to DISTINCT final destination paths. They are never
        // read from and written to the same path (that previously crashed EEXIST).
        const preSrc = join(ev, `${cslug}.${mode}.prestart.json`);
        const finSrc = join(ev, `${cslug}.${mode}.final.json`);
        writeFileSync(preSrc, JSON.stringify(pre));
        writeFileSync(finSrc, JSON.stringify(fin));
        invs[mode] = {
          argv: tokens(mode), exit: mode === 'help' ? 0 : 2, signal: null, spawnError: null, timedOut: false,
          usagePrinted: true, entrypointExecuted: true, traceName: `${cslug}.${mode}.trace`, args: M_ARGS[mode], out: 'usage\n', err: '',
          runtimeConfig: runtime.runtimeConfig, runtimeConfigRel: runtime.runtimeConfigRel, tsxLoader: runtime.tsxLoader, runtimeContext: runtime.runtimeContext,
          contextKey: c.contextKey, cwdRel: c.cwdRel, nativeCwd, nativeSubject, containerId: cid, workingDirInspect: wdInspectMode,
          prestartReceiptPath: preSrc, finalReceiptPath: finSrc,
        };
      }
      contextResults.push({
        contextKey: c.contextKey, rel: c.rel, cwdRel: c.cwdRel, kind: c.kind,
        declarationRefs: c.declarationRefs, declarations: c.declarations, manifestInputs: c.manifestInputs, fingerprint: c.fingerprint,
        status: 'ok', reasons: [], invocations: invs,
      });
    }
    const logRel = `${relDir}${slug}.log`;
    writeFileSync(join(root, logRel), `$ node ${s.path}\n`);
    rawLogHashes[s.path] = sha256file(join(root, logRel));
    const r = {
      rel: s.path, subject: s.source, status: 'ok', contract,
      noArgs: { exit: 2, usagePrinted: true, timedOut: false },
      help: { exit: 0, usagePrinted: true, timedOut: false },
      evidenceDir: ev, rawLogPath: logRel, rawLogSha256: rawLogHashes[s.path],
      contextResults,
    };
    results.push(toEvidenceResult(root, relDir, r, used, problems, sourceSha));
  }

  const isoRel = `${relDir}isolation-selftest.json`;
  const selfTest = { subject: 'containment-selftest', network: { target: '1.1.1.1:80', denied: true }, write: { target: '/probe-write-selftest', denied: true } };
  writeFileSync(join(root, isoRel), JSON.stringify(selfTest));
  const isolation = {
    networkDenied: true, hostWriteDenied: true,
    mechanism: 'synthetic control fixture (no runtime executed)',
    proof: {
      exercised: true,
      networkAttempts: [{ subject: 'containment-selftest', kind: 'net.connect', target: '1.1.1.1:80', denied: true }],
      writeAttempts: [{ subject: 'containment-selftest', kind: 'fs.write', target: '/probe-write-selftest', denied: true }],
    },
    selfTestRawPath: isoRel, selfTestRawSha256: sha256file(join(root, isoRel)),
  };
  const artifact = {
    schema: SMOKE_EVIDENCE_SCHEMA,
    schemaVersion: SMOKE_EVIDENCE_VERSION,
    generatedAt: new Date().toISOString(),
    run: { complete: true, partial: false },
    source: { commitSha, fingerprintAlgorithm: 'sha256-fixture-v1', fingerprint: synthFingerprint(root), specs: canonicalSmokeSpecs(root) },
    discovery: { subjects: subjects.map((s) => ({ path: s.path, source: s.source })), count: subjects.length },
    isolation, results, rawLogHashes,
  };
  return { artifact, emitterProblems: problems };
}

// ─────────────────── ACTUAL integrated canonical roundtrip fixture ───────────────────
// One physical subject declared from TWO package cwd contexts (root `.` and
// `apps/tools`), with two same-cwd aliases coalescing into the `.` context. The
// ACTUAL canonical `smokeOneContext` → `runWithAttemptAudit` → `runIsolated` run all
// three smoke modes for BOTH contexts through an owned injected Docker seam (no
// daemon contacted); the ACTUAL canonical emitter (`toEvidenceResult`) and the ACTUAL
// independent verifier (`validateSmokeEvidence`) then consume those ACTUAL-produced
// invocations/receipts. Honest synthetic Docker responses only — NO native claim.

/** The subject source: a documented no-args usage branch (exit 2) + --help (exit 0). */
const ROUNDTRIP_SRC = [
  'const args = process.argv.slice(2);',
  "if (args.includes('--help')) { console.log('Usage: x <value>'); process.exit(0); }",
  "if (args.some((a) => a.startsWith('--'))) { console.error('Usage: x <value>'); process.exit(2); }",
  "if (args.length === 0) { console.error('Usage: x <value>'); process.exit(2); }",
  '',
].join('\n');

/** Build a synthetic repo: one physical subject declared from TWO package cwd contexts. */
function roundtripRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-rt-'));
  mkdirSync(join(root, 'scripts', 'cleanup-script-smoke'), { recursive: true });
  mkdirSync(join(root, 'apps', 'tools'), { recursive: true });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - scripts\n');
  // Root package: TWO same-cwd aliases (both from cwd '.') → coalesced into ONE context.
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@probe/root', private: true,
    scripts: { one: 'node scripts/x.mjs --provenance-only', alias: 'node scripts/x.mjs --another-declaration' },
  }, null, 2) + '\n');
  // A SECOND package cwd declaring the SAME physical subject.
  writeFileSync(join(root, 'apps', 'tools', 'package.json'), JSON.stringify({
    name: '@probe/tools',
    scripts: { two: 'node ../../scripts/x.mjs --never-replay' },
  }, null, 2) + '\n');
  mkdirSync(join(root, 'apps', 'unused-resolver'), { recursive: true });
  writeFileSync(join(root, 'apps', 'unused-resolver', 'package.json'), JSON.stringify({
    name: '@probe/unused-resolver', private: true,
  }, null, 2) + '\n');
  writeFileSync(join(root, 'scripts', 'x.mjs'), ROUNDTRIP_SRC);
  return root;
}

/**
 * An owned injected Docker seam for ONE canonical context. It records six distinct
 * container identities (3 modes x 2 contexts), writes the mode exec trace into the
 * owned evidence dir, and answers ownership / WorkingDir / absence inspections from
 * the owned container map — never contacting a daemon. `workingDir` forces the
 * inspected WorkingDir to 'malformed' / 'wrong' (adverse controls); `emptyHelpTrace`
 * suppresses the help trace (a failed mode).
 */
function roundtripSpawn({ root, ev, context, ctxIndex, calls, containers, workingDir = 'ok', emptyHelpTrace = false }) {
  const expectedCwd = nativeCwdFor(context.cwdRel, { mountedVolume: true, nativeRoot: root });
  const nativeSubject = `/src/${normalizeRel(context.rel)}`;
  let count = 0;
  return (cmd, args = []) => {
    if (cmd !== 'docker') throw new Error(`unexpected executable ${cmd}`);
    const res = (status = 0, stdout = '', stderr = '') => ({ status, stdout, stderr, signal: null, error: undefined });
    const sub = args[0];
    if (sub === 'create') {
      const cid = createHash('sha256').update(`rt|${context.contextKey}|${ctxIndex}|${count}`).digest('hex');
      const ci = args.indexOf('--cidfile');
      if (ci >= 0) writeFileSync(args[ci + 1], cid);
      const label = String(args.find((x) => String(x).startsWith('cleanup-smoke.run=')) ?? '').slice('cleanup-smoke.run='.length);
      const si = args.indexOf(nativeSubject);
      const modeArgs = si >= 0 ? args.slice(si + 1) : [];
      const oi = args.indexOf('-o');
      const traceName = oi >= 0 ? String(args[oi + 1]).replace(/^\/evidence\//, '') : `ctx${ctxIndex}.${count}.trace`;
      if (!(emptyHelpTrace && modeArgs.includes('--help'))) {
        writeFileSync(join(ev, traceName), `123 execve("/usr/bin/node", [${['node', nativeSubject, ...modeArgs].map((t) => JSON.stringify(t)).join(', ')}], 0x0) = 0\n`);
      }
      containers.set(cid, { contextKey: context.contextKey, label, modeArgs, removed: false, cwd: expectedCwd });
      calls.push({ contextKey: context.contextKey, command: 'create' });
      count += 1;
      return res();
    }
    const cid = args[args.length - 1];
    const container = containers.get(cid);
    if (sub === 'inspect') {
      if (!container || container.removed) return res(1, '', `Error: No such container: ${cid}`);
      const fmt = String(args[2] ?? '');
      if (/Labels/.test(fmt)) return res(0, `${cid}|${container.label}`);
      if (/WorkingDir/.test(fmt)) {
        if (workingDir === 'malformed') return res(0, 'not-json');
        if (workingDir === 'wrong') return res(0, JSON.stringify('/foreign/wrong-cwd'));
        return res(0, JSON.stringify(container.cwd));
      }
      return res(1, '', `Error: No such container: ${cid}`);
    }
    if (!container) throw new Error(`unknown injected container ${cid}`);
    calls.push({ contextKey: context.contextKey, command: sub });
    if (sub === 'start') return res();
    if (sub === 'wait') return res(0, container.modeArgs.includes('--help') ? '0' : '2');
    if (sub === 'logs') return res(0, 'Usage: x <value>\n');
    if (sub === 'rm') { container.removed = true; return res(); }
    throw new Error(`unexpected docker command ${sub}`);
  };
}

/** A frozen-volume evidence ctx (the ACTUAL runs mount the read-only /src volume). */
function roundtripCtx(root) {
  return { ...synthCtx(root), nativeTopology: { mode: 'frozen-volume' } };
}

/** Build the artifact with the REAL emitter over the ACTUAL-produced contextResults. */
function buildRoundtripArtifact(root, entry, contextResults) {
  const problems = [];
  const used = new Set();
  const commitSha = 'a'.repeat(40);
  const relDir = 'docs/plans/cleanup1-script-smoke-live/run-1/';
  mkdirSync(join(root, relDir), { recursive: true });
  const subjects = canonicalSmokeSubjects(root);
  const sourceSha = sha256file(join(root, entry.rel));
  const primary = contextResults[0];
  const pn = primary.invocations.noArgs;
  const ph = primary.invocations.help;
  // The physical result identity is the ACTUAL aggregate over every context (a
  // static-flagged subject that passes every context is `ok` with its retained
  // warning/provenance; any failing context fails the whole subject).
  const agg = aggregateContexts(entry, contextResults);
  const status = agg.status;
  const logRel = `${relDir}${entry.rel.replace(/[^A-Za-z0-9._-]+/g, '__')}.log`;
  writeFileSync(join(root, logRel), `# smoke raw log: ${entry.rel}\n`);
  const r = {
    rel: entry.rel, subject: entry.subject, status, contract: primary.contract,
    ...(Array.isArray(agg.packets) ? { packets: agg.packets } : {}),
    ...(Array.isArray(agg.warnings) ? { warnings: agg.warnings } : {}),
    ...(agg.staticRisk ? { staticRisk: agg.staticRisk } : {}),
    noArgs: { exit: pn.exit, usagePrinted: pn.usagePrinted === true, timedOut: pn.timedOut === true },
    help: { exit: ph.exit, usagePrinted: ph.usagePrinted === true, timedOut: ph.timedOut === true },
    evidenceDir: primary.evidenceDir ?? root, rawLogPath: logRel, rawLogSha256: sha256file(join(root, logRel)),
    contextResults,
  };
  const result = toEvidenceResult(root, relDir, r, used, problems, sourceSha);
  const isoRel = `${relDir}isolation-selftest.json`;
  const selfTest = { subject: 'containment-selftest', network: { target: '1.1.1.1:80', denied: true }, write: { target: '/probe-write-selftest', denied: true } };
  writeFileSync(join(root, isoRel), JSON.stringify(selfTest));
  const isolation = {
    networkDenied: true, hostWriteDenied: true,
    mechanism: 'synthetic control fixture (no runtime executed)',
    proof: {
      exercised: true,
      networkAttempts: [{ subject: 'containment-selftest', kind: 'net.connect', target: '1.1.1.1:80', denied: true }],
      writeAttempts: [{ subject: 'containment-selftest', kind: 'fs.write', target: '/probe-write-selftest', denied: true }],
    },
    selfTestRawPath: isoRel, selfTestRawSha256: sha256file(join(root, isoRel)),
  };
  const artifact = {
    schema: SMOKE_EVIDENCE_SCHEMA,
    schemaVersion: SMOKE_EVIDENCE_VERSION,
    generatedAt: new Date().toISOString(),
    run: { complete: true, partial: false },
    source: { commitSha, fingerprintAlgorithm: 'sha256-fixture-v1', fingerprint: synthFingerprint(root), specs: canonicalSmokeSpecs(root) },
    discovery: { subjects: subjects.map((s) => ({ path: s.path, source: s.source })), count: subjects.length },
    isolation, results: [result], rawLogHashes: { [entry.rel]: sha256file(join(root, logRel)) },
  };
  return { artifact, emitterProblems: problems };
}

export function runRuntimeEvidenceControls() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const root = syntheticRepo();
  const subjectTs = 'apps/api/scripts/x.ts';
  const subjectJs = 'scripts/y.mjs';

  // ---- source config selection (real) -------------------------------------
  const selTs = selectSourceAppTsConfig(root, subjectTs);
  const configRel = 'apps/api/tsconfig.json';
  add('selection: the committed app config is selected for the TS subject',
    selTs.ok === true && selTs.applicable === true && selTs.configRel === configRel, JSON.stringify(selTs));
  const selJs = selectSourceAppTsConfig(root, subjectJs);
  add('selection: a non-TS subject selects no config', selJs.ok === true && selJs.applicable === false, JSON.stringify(selJs));

  // ---- run-smoke plan derivation (real) ------------------------------------
  const plan = expectedRuntimePlanFor(root, subjectTs, null, { volume: 'v' });
  const cfgFrozen = `/src/${configRel}`;
  add('plan(run-smoke): a frozen-volume TS subject binds /src/<config> + the committed loader',
    plan.ok === true && plan.context === 'frozen-volume' && plan.config === cfgFrozen && plan.loader === SMOKE_TSX_LOADER_REL, JSON.stringify(plan));
  // A CONTEXT-BOUND frozen obligation binds the ABSOLUTE read-only /src loader that
  // the real context-bound isolation.mjs run mounts (`/src/${TSX_CLI_REL}`).
  const planCtx = expectedRuntimePlanFor(root, subjectTs, null, { volume: 'v' }, { contextBound: true });
  add('plan(run-smoke): a CONTEXT-BOUND frozen-volume TS subject binds the ABSOLUTE /src/<loader>',
    planCtx.ok === true && planCtx.context === 'frozen-volume' && planCtx.config === cfgFrozen && planCtx.loader === `/src/${SMOKE_TSX_LOADER_REL}`,
    JSON.stringify(planCtx));

  // ---- gate plan derivation (real) -----------------------------------------
  const gateExp = expectedSmokeRuntimeFor({ root }, subjectTs);
  add('plan(gate): the gate independently re-derives the same committed config',
    gateExp.ok === true && gateExp.applicable === true && gateExp.configRel === configRel, JSON.stringify(gateExp));
  const gateJs = expectedSmokeRuntimeFor({ root }, subjectJs);
  add('plan(gate): a non-TS subject is non-applicable (strict null/null)',
    gateJs.ok === true && gateJs.applicable === false, JSON.stringify(gateJs));

  // ---- exec proof with the derived plan (correct app config ACCEPTED) -------
  const parse = (t) => parseSyscallTrace(t);
  const okTrace = execveLine(SMOKE_TSX_LOADER_REL, cfgFrozen, subjectTs);
  add('exec: the exact bound plan (frozen-volume config + loader) is ACCEPTED',
    entrypointExecutedFromTrace(parse(okTrace), { subject: subjectTs, args: [], runtimeConfig: cfgFrozen, loader: SMOKE_TSX_LOADER_REL }) === true, okTrace.trim());

  // requirement is the committed config; a trace naming a DIFFERENT app config is refused.
  const otherCfg = '/src/apps/web/tsconfig.json';
  const wrongTrace = execveLine(SMOKE_TSX_LOADER_REL, otherCfg, subjectTs);
  add('exec: a trace bound to a WRONG app config is refused',
    entrypointExecutedFromTrace(parse(wrongTrace), { subject: subjectTs, args: [], runtimeConfig: cfgFrozen, loader: SMOKE_TSX_LOADER_REL }) === false, wrongTrace.trim());

  const missingCfgTrace = execveLine(SMOKE_TSX_LOADER_REL, null, subjectTs);
  add('exec: a trace MISSING the config is refused',
    entrypointExecutedFromTrace(parse(missingCfgTrace), { subject: subjectTs, args: [], runtimeConfig: cfgFrozen, loader: SMOKE_TSX_LOADER_REL }) === false, missingCfgTrace.trim());

  // loader-only (no subject) is never proof of the executed subject.
  const loaderOnly = execveLine(SMOKE_TSX_LOADER_REL, cfgFrozen, 'apps/api/scripts/other.ts');
  add('exec: a loader-only / unrelated-subject trace is refused',
    entrypointExecutedFromTrace(parse(loaderOnly), { subject: subjectTs, args: [], runtimeConfig: cfgFrozen, loader: SMOKE_TSX_LOADER_REL }) === false, loaderOnly.trim());

  // unbound --tsconfig under the LEGACY branch (no plan) is a REFUSAL.
  add('exec: an unbound --tsconfig under the legacy (no-plan) branch is refused',
    entrypointExecutedFromTrace(parse(okTrace), { subject: subjectTs, args: [] }) === false, 'legacy refusal');

  // extra argv (a trailing unexpected flag) fails the exact-length check.
  const extraTrace = execveLine(SMOKE_TSX_LOADER_REL, cfgFrozen, subjectTs, ['--extra']);
  add('exec: an EXTRA argv token is refused',
    entrypointExecutedFromTrace(parse(extraTrace), { subject: subjectTs, args: [], runtimeConfig: cfgFrozen, loader: SMOKE_TSX_LOADER_REL }) === false, extraTrace.trim());

  // ---- non-TS strict null/null ---------------------------------------------
  const jsTrace = execveLine(null, null, subjectJs);
  add('exec: a non-TS subject with the strict null/null plan is ACCEPTED',
    entrypointExecutedFromTrace(parse(jsTrace), { subject: subjectJs, args: [], runtimeConfig: null, loader: null }) === true, jsTrace.trim());
  add('exec: a non-TS subject with an unexpected loader is refused',
    entrypointExecutedFromTrace(parse(execveLine(SMOKE_TSX_LOADER_REL, null, subjectJs)), { subject: subjectJs, args: [], runtimeConfig: null, loader: null }) === false, 'unexpected loader');

  // ---- real emitter threads the plan + context binding into the raw record ----
  {
    const repo = mkdtempSync(join(tmpdir(), 'cleanup-rte-emit-'));
    mkdirSync(join(repo, 'apps', 'api', 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'apps', 'api', 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
    writeFileSync(join(repo, 'apps', 'api', 'scripts', 'x.ts'), 'export const x = 1;\n');
    const ev = mkdtempSync(join(tmpdir(), 'cleanup-rte-ev-'));
    const ctxKey = `invctx::${subjectTs}::.`;
    const CID = 'c'.repeat(64);
    const nativeSubject = `/src/${subjectTs}`;
    const nativeCwd = '/src';
    const wdRaw = JSON.stringify(nativeCwd) + '\n';
    const wdInspect = {
      inspectExit: 0, inspectSignal: null, inspectError: null, stdoutRaw: wdRaw, stderrRaw: '',
      stdoutSha256: createHash('sha256').update(Buffer.from(wdRaw, 'utf8')).digest('hex'), stderrSha256: createHash('sha256').update(Buffer.from('', 'utf8')).digest('hex'),
      stdoutBytes: Buffer.byteLength(wdRaw, 'utf8'), stderrBytes: 0, raw: wdRaw.trim(), parsed: nativeCwd, expected: nativeCwd, verified: true, parseOk: true, exactContainerId: CID, contextKey: ctxKey, reason: null,
    };
    const traces = { noArgs: [], help: ['--help'], unknown: ['--cleanup-smoke-unknown-flag'] };
    const mkReceipt = (mode, final) => {
      const base = {
        schemaVersion: 1, runId: `run-1-${mode}`, containerId: CID, label: `cleanup-smoke.run=run-1-${mode}`, subject: subjectTs, modeArgs: traces[mode], contextKey: ctxKey, nativeCwd, nativeSubject, createdAt: '2026-10-10T00:00:00.000Z',
      };
      return final
        ? { ...base, startExit: 0, waitExit: 0, logsExit: 0, startFailed: false, logsUnavailable: false, waitUnavailable: false, waitDeadline: false, containerExit: 2, timedOut: false, removal: { removed: true, unknown: false, detail: 'removed' }, finishedAt: '2026-10-10T00:00:01.000Z' }
        : base;
    };
    const invocations = {};
    for (const [mode, args] of Object.entries(traces)) {
      writeFileSync(join(ev, `${mode}.trace`), execveLine(SMOKE_TSX_LOADER_REL, cfgFrozen, nativeSubject, args));
      const prePath = join(repo, 'out', `${mode}.prestart.json`);
      const finPath = join(repo, 'out', `${mode}.final.json`);
      mkdirSync(join(repo, 'out'), { recursive: true });
      writeFileSync(prePath, JSON.stringify(mkReceipt(mode, false)));
      writeFileSync(finPath, JSON.stringify(mkReceipt(mode, true)));
      invocations[mode] = {
        argv: ['node', SMOKE_TSX_LOADER_REL, '--tsconfig', cfgFrozen, nativeSubject, ...args],
        exit: 2, signal: null, spawnError: null, timedOut: false, usagePrinted: true,
        entrypointExecuted: true, traceName: `${mode}.trace`, args, out: 'usage', err: '',
        runtimeConfig: cfgFrozen, runtimeConfigRel: configRel, tsxLoader: SMOKE_TSX_LOADER_REL, runtimeContext: 'frozen-volume',
        contextKey: ctxKey, cwdRel: '.', nativeCwd, nativeSubject, containerId: CID, workingDirInspect: wdInspect,
        prestartReceiptPath: prePath, finalReceiptPath: finPath,
      };
    }
    const r = {
      rel: subjectTs, subject: 'root/scripts', status: 'ok', contract: {}, evidenceDir: ev,
      noArgs: { exit: 2, usagePrinted: true, timedOut: false },
      help: { exit: 0, usagePrinted: true, timedOut: false },
      contextResults: [{ contextKey: ctxKey, rel: subjectTs, cwdRel: '.', kind: 'entrypoint', declarationRefs: [], declarations: [], manifestInputs: [], fingerprint: 'a'.repeat(64), status: 'ok', reasons: [], invocations }],
    };
    const problems = [];
    const rec = toEvidenceResult(repo, 'out/', r, new Set(), problems, 'a'.repeat(64));
    // The REAL `toEvidenceResult` returns a per-result SUMMARY that points at the
    // emitted raw invocation record via `invocationsRawPath` (it does NOT inline the
    // record under a `record` field). Parse the ACTUAL emitted raw JSON — never expect
    // a `record.invocations` shape the emitter does not produce.
    const invRec = JSON.parse(readFileSync(resolve(repo, rec.invocationsRawPath), 'utf8'));
    const inv = invRec.invocations.noArgs;
    const ctxInv = invRec.contexts[0].invocations.noArgs;
    add('emitter: the raw invocation record carries the bound runtime plan',
      inv.runtimeConfig === cfgFrozen && inv.tsxLoader === SMOKE_TSX_LOADER_REL &&
      inv.runtimeConfigRel === configRel && inv.runtimeContext === 'frozen-volume' &&
      inv.entrypointExecuted === true && inv.contextKey === ctxKey && inv.nativeSubject === nativeSubject &&
      ctxInv.prestartRawPath && ctxInv.finalRawPath,
      JSON.stringify({ cfg: inv.runtimeConfig, loader: inv.tsxLoader, ctx: inv.runtimeContext, executed: inv.entrypointExecuted, key: inv.contextKey }));
    add('emitter: no problems are recorded for the correct-plan synthetic run', problems.length === 0, JSON.stringify(problems));
  }

  // The exact native failure shape: a declared CLI failed discovery, so no
  // invocation object exists. The emitter must retain it as a red packet with
  // explicit nulls and problems, rather than crashing before evidence is saved.
  {
    const repo = mkdtempSync(join(tmpdir(), 'cleanup-rte-nonexecuted-'));
    const rel = 'scripts/missing.mjs';
    const reason = 'declared CLI target does not resolve to a file';
    const packet = {
      rel, subject: 'declared-missing', status: 'declaration-discovery-mismatch',
      reasons: [reason], packets: ['UNDISCOVERED-DECLARED-COMMAND'],
      contextResults: [{
        contextKey: `invctx::${rel}::.`, rel, cwdRel: '.', kind: 'undiscovered-declared',
        declarationRefs: ['root#missing'], declarations: [], manifestInputs: [],
        fingerprint: 'a'.repeat(64), status: 'declaration-discovery-mismatch',
        reasons: [reason], invocations: {},
      }],
    };
    const problems = [];
    const rec = toEvidenceResult(repo, 'out/', packet, new Set(), problems, null);
    const raw = JSON.parse(readFileSync(resolve(repo, rec.invocationsRawPath), 'utf8'));
    add('emitter: nonexecuted declaration is retained with explicit null proof fields',
      rec.status === 'declaration-discovery-mismatch' && rec.noArgs.exit === null &&
      rec.noArgs.usagePrinted === null && rec.noArgs.timedOut === null &&
      rec.native.exit === null && rec.native.argv === null && rec.audit === null &&
      rec.auditRawPath === null && rec.auditRawSha256 === null &&
      raw.contexts[0].invocations && Object.keys(raw.contexts[0].invocations).length === 0,
      JSON.stringify({ status: rec.status, noArgs: rec.noArgs, native: rec.native, audit: rec.audit, raw }));
    add('emitter: nonexecuted declaration records reasons and missing proof as problems',
      rec.reasons.includes(reason) && problems.some((p) => p.includes('nonpassing smoke result')) &&
      problems.some((p) => p.includes('noArgs execution was not recorded')),
      JSON.stringify(problems));
  }

  // ---- REAL validateSmokeEvidence via the NORMAL ctx.root discovery path ----
  {
    const repo = acceptanceRepo();
    const { artifact, emitterProblems } = buildSynthArtifact(repo);
    add('validator-fixture: the REAL emitter wrote the raw fixture with no emitter problems',
      emitterProblems.length === 0 && Array.isArray(artifact.results) && artifact.results.length === 2, JSON.stringify(emitterProblems));

    const problems = validateSmokeEvidence(artifact, synthCtx(repo));
    add('validator(normal-path): the correct TS app-config-bound record is ACCEPTED with ZERO problems',
      problems.length === 0, JSON.stringify(problems.slice(0, 8)));

    // Confirm the accepted fixture actually exercised native-bind + the committed
    // /tsruntime loader (not merely a passing helper).
    const tsResult = artifact.results.find((r) => r.path.endsWith('.ts'));
    const invRec = JSON.parse(readFileSync(resolve(repo, tsResult.invocationsRawPath), 'utf8'));
    add('validator(normal-path): the accepted TS record binds native-bind + the EXACT /tsruntime loader',
      invRec.invocations.noArgs.runtimeContext === 'native-bind' &&
      invRec.invocations.noArgs.tsxLoader === `/tsruntime/${TS_RUNTIME_CLI_REL}` &&
      invRec.invocations.noArgs.tsxLoader === TS_RUNTIME_BOUND_LOADER &&
      invRec.invocations.noArgs.runtimeConfigRel === configRel,
      JSON.stringify({ ctx: invRec.invocations.noArgs.runtimeContext, loader: invRec.invocations.noArgs.tsxLoader }));

    // --- negatives: each MUST be rejected by the REAL validator -------------
    const reject = (name, built) => {
      const probs = validateSmokeEvidence(built.artifact, synthCtx(built.root));
      add(name, probs.length > 0, JSON.stringify(probs.slice(0, 4)));
    };

    // wrong-app config: the committed selection is apps/api/tsconfig.json.
    {
      const r2 = acceptanceRepo();
      reject('validator: a TS record bound to a WRONG app config is REJECTED',
        { ...buildSynthArtifact(r2, { tsRuntime: { runtimeConfigRel: 'apps/web/tsconfig.json', runtimeConfig: `${posixHost(r2)}/apps/web/tsconfig.json`, tsxLoader: TS_RUNTIME_BOUND_LOADER, runtimeContext: 'native-bind' } }), root: r2 });
    }
    // missing config: a TS config-bearing subject with NO plan is fail-closed.
    {
      const r2 = acceptanceRepo();
      reject('validator: a TS record with a MISSING runtime plan is REJECTED',
        { ...buildSynthArtifact(r2, { tsRuntime: { runtimeConfig: null, runtimeConfigRel: null, tsxLoader: null, runtimeContext: null } }), root: r2 });
    }
    // forged loader: a known-looking /tsruntime/eviltsx/... path must fail.
    {
      const r2 = acceptanceRepo();
      reject('validator: a FORGED /tsruntime/eviltsx loader is REJECTED',
        { ...buildSynthArtifact(r2, { tsRuntime: { runtimeConfig: `${posixHost(r2)}/${configRel}`, runtimeConfigRel: configRel, tsxLoader: '/tsruntime/eviltsx/dist/cli.mjs', runtimeContext: 'native-bind' } }), root: r2 });
    }
    // extra argv: an unexpected trailing token fails the exact-length proof.
    {
      const r2 = acceptanceRepo();
      reject('validator: an EXTRA argv token is REJECTED',
        { ...buildSynthArtifact(r2, { noArgsExtra: true }), root: r2 });
    }
    // non-TS with an unexpected plan is rejected (strict null/null required).
    {
      const r2 = acceptanceRepo();
      reject('validator: a non-TS record with an UNEXPECTED loader/config is REJECTED',
        { ...buildSynthArtifact(r2, { jsRuntime: { runtimeConfig: `${posixHost(r2)}/${configRel}`, runtimeConfigRel: configRel, tsxLoader: SMOKE_TSX_LOADER_REL, runtimeContext: 'frozen-volume' } }), root: r2 });
    }
    // changed committed CONFIG bytes invalidate the old evidence (canonical fingerprint).
    {
      const r2 = acceptanceRepo();
      const built = buildSynthArtifact(r2);
      writeFileSync(join(r2, 'apps', 'api', 'tsconfig.json'), JSON.stringify({ compilerOptions: { experimentalDecorators: true, target: 'ES2022' } }, null, 2) + '\n');
      const probs = validateSmokeEvidence(built.artifact, synthCtx(r2));
      add('validator: a CHANGED committed config byte invalidates old evidence (canonical fingerprint)',
        probs.some((p) => /fingerprint/.test(p)), JSON.stringify(probs.slice(0, 4)));
    }
    // changed committed SOURCE bytes invalidate the old evidence too.
    {
      const r2 = acceptanceRepo();
      const built = buildSynthArtifact(r2);
      writeFileSync(join(r2, 'apps', 'api', 'scripts', 'x.ts'), ENTRY_SRC + '// changed\n');
      const probs = validateSmokeEvidence(built.artifact, synthCtx(r2));
      add('validator: a CHANGED committed source byte invalidates old evidence',
        probs.some((p) => /fingerprint|sourceSha256/.test(p)), JSON.stringify(probs.slice(0, 4)));
    }

    // ---- the NINE independent Root-1130 adverse mutations MUST each be rejected ----
    // Each mutation is applied to the ACTUAL emitted raw invocation record AND its
    // raw digest recomputed, so these are SEMANTIC gaps (every changed raw file is
    // rehashed) — never digest omissions. Uses the REAL emitter + REAL validator.
    const saveRaw = (rt, rel, obj) => { const bytes = Buffer.from(JSON.stringify(obj)); writeFileSync(join(rt, rel), bytes); return sha256buf(bytes); };
    const receiptMut = (rt, inv, which, fn) => { const pk = `${which}RawPath`, hk = `${which}RawSha256`; const obj = JSON.parse(readFileSync(join(rt, inv[pk]), 'utf8')); fn(obj); inv[hk] = saveRaw(rt, inv[pk], obj); };
    const eachInv = (rec, fn) => { for (const c of rec.contexts) for (const [mode, inv] of Object.entries(c.invocations)) fn(inv, mode, c); };
    const mutate1130 = (name, mutate) => {
      const rt = acceptanceRepo();
      const built = buildSynthArtifact(rt);
      const r = built.artifact.results.find((x) => x.path === 'scripts/y.mjs');
      const rec = JSON.parse(readFileSync(join(rt, r.invocationsRawPath), 'utf8'));
      if (mutate) {
        mutate(rt, r, rec);
        rec.invocations = rec.contexts[0].invocations;
        r.native.argv = rec.invocations.noArgs.argv;
        r.invocationsRawSha256 = saveRaw(rt, r.invocationsRawPath, rec);
      }
      const probs = validateSmokeEvidence(built.artifact, synthCtx(rt));
      add(name, probs.length > 0, JSON.stringify(probs.slice(0, 3)));
    };
    // (1) forged absolute cwd, consistently changed across invocation + both receipts.
    mutate1130('root1130-1: a forged absolute native cwd (rehashed) is REJECTED',
      (rt, r, rec) => eachInv(rec, (inv) => {
        inv.nativeCwd = '/foreign/owned-looking-cwd';
        const wd = inv.workingDirInspect;
        wd.expected = wd.parsed = inv.nativeCwd;
        wd.stdoutRaw = JSON.stringify(inv.nativeCwd) + '\n';
        wd.raw = wd.stdoutRaw.trim();
        wd.stdoutSha256 = sha256buf(Buffer.from(wd.stdoutRaw, 'utf8'));
        wd.stdoutBytes = Buffer.byteLength(wd.stdoutRaw, 'utf8');
        for (const which of ['prestart', 'final']) receiptMut(rt, inv, which, (x) => { x.nativeCwd = inv.nativeCwd; x.workingDirInspect = wd; });
      }));
    // (2) foreign absolute subject, consistently changed across argv/trace/receipts.
    mutate1130('root1130-2: a foreign absolute native subject (consistent exec trace) is REJECTED',
      (rt, r, rec) => eachInv(rec, (inv) => {
        const old = inv.nativeSubject;
        inv.nativeSubject = '/foreign/' + r.path;
        inv.argv = inv.argv.map((x) => (x === old ? inv.nativeSubject : x));
        const p = join(rt, inv.traceTextRawPath);
        const bytes = Buffer.from(readFileSync(p, 'utf8').replaceAll(old, inv.nativeSubject));
        writeFileSync(p, bytes);
        inv.traceTextRawSha256 = sha256buf(bytes);
        inv.traceTextBytes = bytes.length;
        for (const which of ['prestart', 'final']) receiptMut(rt, inv, which, (x) => { x.nativeSubject = inv.nativeSubject; });
      }));
    // (3) forged receipt owner label/ownership/source/runtime.
    mutate1130('root1130-3: a forged receipt owner/source/runtime is REJECTED',
      (rt, r, rec) => eachInv(rec, (inv) => {
        for (const which of ['prestart', 'final']) receiptMut(rt, inv, which, (x) => {
          x.label = 'cleanup-smoke.run=foreign';
          x.ownership = { verified: false, inspectExit: 19, raw: 'foreign' };
          x.source = { sha256: 'f'.repeat(64), path: 'foreign' };
          x.runtimeConfig = '/foreign/tsconfig.json';
          x.tsxLoader = '/foreign/loader.mjs';
        });
      }));
    // (4) final receipt modeArgs differs from the exact mode (only prestart was checked before).
    mutate1130('root1130-4: a final-receipt modeArgs mismatch is REJECTED',
      (rt, r, rec) => eachInv(rec, (inv) => receiptMut(rt, inv, 'final', (x) => { x.modeArgs = ['--foreign']; })));
    // (5) final receipt createdAt forged to 2099 after finish (prestart createdAt unchanged).
    mutate1130('root1130-5: a final-receipt createdAt after finish is REJECTED',
      (rt, r, rec) => eachInv(rec, (inv) => receiptMut(rt, inv, 'final', (x) => { x.createdAt = '2099-01-01T00:00:00.000Z'; })));
    // (6) inspectSignal and inspectError omitted altogether (undefined, not explicit null).
    mutate1130('root1130-6: an omitted inspectSignal/inspectError is REJECTED',
      (rt, r, rec) => eachInv(rec, (inv) => {
        delete inv.workingDirInspect.inspectSignal;
        delete inv.workingDirInspect.inspectError;
        for (const which of ['prestart', 'final']) receiptMut(rt, inv, which, (x) => { x.workingDirInspect = inv.workingDirInspect; });
      }));
    // (7) the same CID/run reused across all three modes (rehashed receipts).
    mutate1130('root1130-7: a CID/run reused across modes is REJECTED',
      (rt, r, rec) => eachInv(rec, (inv) => {
        inv.containerId = 'c'.repeat(64);
        inv.workingDirInspect.exactContainerId = inv.containerId;
        for (const which of ['prestart', 'final']) receiptMut(rt, inv, which, (x) => {
          x.runId = 'same-run-for-all-modes';
          x.containerName = 'cleanup-smoke-same-run-for-all-modes';
          x.containerId = inv.containerId;
          x.label = 'cleanup-smoke.run=same-run-for-all-modes';
          x.workingDirInspect = inv.workingDirInspect;
        });
      }));
    // (8) forged summary context fingerprint / declarationRefs / manifestInputs.
    mutate1130('root1130-8: a forged summary context provenance is REJECTED',
      (_rt, r) => { r.contexts[0].fingerprint = 'f'.repeat(64); r.contexts[0].declarationRefs = ['foreign#cmd']; r.contexts[0].manifestInputs = []; });
    // (9) forged summary context cwd.
    mutate1130('root1130-9: a forged summary context cwd is REJECTED',
      (_rt, r) => { r.contexts[0].cwdRel = 'foreign'; });

    // Healthy REAL-producer-shaped roundtrip (complete receipts) MUST pass with ZERO.
    {
      const rt = acceptanceRepo();
      const built = buildSynthArtifact(rt);
      const probs = validateSmokeEvidence(built.artifact, synthCtx(rt));
      add('validator(roundtrip): the complete real-producer-shaped fixture is ACCEPTED with ZERO problems',
        probs.length === 0, JSON.stringify(probs.slice(0, 6)));
    }

    // ---- ACTUAL producer WorkingDir raw shape (round-1158) ------------------
    // The producer sets `workingDirInspect.raw = stdoutRaw.trim()`, which for a real
    // `docker inspect --format {{json .Config.WorkingDir}}` is the JSON STRING
    // LITERAL (`"/src"`, quotes included), NOT the decoded path. This is a POSITIVE
    // actual-producer-shape case (not an adverse mutation): the raw literal is
    // accepted, and the decoded cwd is recovered INDEPENDENTLY from the retained
    // stdout bytes.
    {
      const rt = acceptanceRepo();
      const built = buildSynthArtifact(rt);
      const rr = built.artifact.results.find((x) => x.path === 'scripts/y.mjs');
      const rec = JSON.parse(readFileSync(join(rt, rr.invocationsRawPath), 'utf8'));
      const wd = rec.invocations.noArgs.workingDirInspect;
      add('validator(actual-producer): workingDirInspect.raw is the EXACT retained stdoutRaw.trim() JSON literal, not the decoded path',
        typeof wd.raw === 'string' && wd.raw === wd.stdoutRaw.trim() && wd.raw !== wd.parsed && JSON.parse(wd.raw) === wd.parsed,
        JSON.stringify({ raw: wd.raw, parsed: wd.parsed }));
      const probs = validateSmokeEvidence(built.artifact, synthCtx(rt));
      add('validator(actual-producer): the actual-producer-shaped WorkingDir raw is ACCEPTED with ZERO problems',
        probs.length === 0, JSON.stringify(probs.slice(0, 4)));
    }
    // A WRONG raw string (the decoded path, NOT the retained JSON literal) is REJECTED
    // even though every stdout digest/byte-count is recomputed consistently.
    mutate1130('root1158-1: a workingDirInspect.raw that is NOT stdoutRaw.trim() (decoded path, rehashed) is REJECTED',
      (rt, r, rec) => eachInv(rec, (inv) => {
        const wd = inv.workingDirInspect;
        wd.raw = wd.parsed; // the decoded path — NOT the retained JSON literal
        for (const which of ['prestart', 'final']) receiptMut(rt, inv, which, (x) => { x.workingDirInspect = wd; });
      }));
    // A WRONG stdoutRaw (rehashed) whose `raw` matches it but decodes to the WRONG cwd
    // is REJECTED by the independent decode — `raw` equality alone is never enough.
    mutate1130('root1158-2: a workingDirInspect stdoutRaw decoding to a WRONG cwd (rehashed, raw matched) is REJECTED',
      (rt, r, rec) => eachInv(rec, (inv) => {
        const wd = inv.workingDirInspect;
        wd.stdoutRaw = JSON.stringify('/foreign/wrong-cwd') + '\n';
        wd.raw = wd.stdoutRaw.trim();
        wd.parsed = '/foreign/wrong-cwd';
        wd.expected = '/foreign/wrong-cwd';
        wd.stdoutSha256 = sha256buf(Buffer.from(wd.stdoutRaw, 'utf8'));
        wd.stdoutBytes = Buffer.byteLength(wd.stdoutRaw, 'utf8');
        for (const which of ['prestart', 'final']) receiptMut(rt, inv, which, (x) => { x.workingDirInspect = wd; });
      }));
  }

  // ── ACTUAL integrated canonical roundtrip (one physical subject, TWO cwd contexts) ──
  // One physical subject (`scripts/x.mjs`) declared from TWO package cwd contexts
  // (root `.` with two coalesced same-cwd aliases, and `apps/tools`). The ACTUAL
  // canonical `smokeOneContext` → `runWithAttemptAudit` → `runIsolated` run all three
  // smoke modes for BOTH contexts through an owned injected Docker seam; the ACTUAL
  // canonical emitter (`toEvidenceResult`) and the ACTUAL independent verifier
  // (`validateSmokeEvidence`) consume those actual invocations/receipts — never
  // fabricated receipt fields. Honest synthetic Docker responses only — NO native
  // qualification is claimed.
  try {
    const root = roundtripRepo();
    const entry = { rel: 'scripts/x.mjs', subject: 'root scripts/*.mjs', kind: 'entrypoint', destructive: [] };
    const plan = planInvocationContexts(root);
    const obligations = plan.contexts.filter((c) => c.rel === 'scripts/x.mjs');
    add('roundtrip: one physical subject carries TWO distinct canonical cwd contexts',
      obligations.length === 2 && new Set(obligations.map((c) => c.cwdRel)).size === 2,
      JSON.stringify(obligations.map((c) => c.cwdRel)));
    const dotCtx = obligations.find((c) => c.cwdRel === '.');
    add('roundtrip: same-cwd declaration aliases coalesce into ONE context (both declarations retained)',
      !!dotCtx && Array.isArray(dotCtx.declarations) && dotCtx.declarations.length === 2,
      JSON.stringify(dotCtx ? dotCtx.declarations.length : null));

    const calls = [];
    const containers = new Map();
    const receiptsDir = join(root, 'owned-receipts');
    mkdirSync(receiptsDir, { recursive: true });
    const prevReceipts = process.env.CLEANUP_SMOKE_RECEIPTS;
    process.env.CLEANUP_SMOKE_RECEIPTS = receiptsDir;
    let contextResults = [];
    const firstFiles = [];
    try {
      contextResults = obligations.map((c, i) => {
        const ev = mkdtempSync(join(tmpdir(), 'cleanup-rt-ev-'));
        const result = smokeOneContext(root, entry, c, 5000, 'owned-audit-image-unused', ev, null, { volume: 'owned-frozen-volume', completed: true, verifiedLabel: true }, i, { spawn: roundtripSpawn({ root, ev, context: c, ctxIndex: i, calls, containers }) });
        if (i === 0) {
          for (const mode of ['noArgs', 'help', 'unknown']) {
            const inv = result.invocations[mode];
            for (const p of [inv.prestartReceiptPath, inv.finalReceiptPath, inv.tracePath]) {
              firstFiles.push({ path: p, sha256: sha256buf(readFileSync(p)) });
            }
          }
        }
        return result;
      });
    } finally {
      if (prevReceipts === undefined) delete process.env.CLEANUP_SMOKE_RECEIPTS;
      else process.env.CLEANUP_SMOKE_RECEIPTS = prevReceipts;
    }

    add('roundtrip: the ACTUAL smokeOneContext runs all three modes for BOTH contexts and every invocation executed',
      contextResults.length === 2 && contextResults.every((c) => c.status === 'ok' && ['noArgs', 'help', 'unknown'].every((m) => c.invocations?.[m]?.entrypointExecuted === true && c.invocations?.[m]?.auditOk === true)),
      JSON.stringify(contextResults.map((c) => ({ status: c.status, modes: ['noArgs', 'help', 'unknown'].map((m) => c.invocations?.[m]?.entrypointExecuted) }))));
    add('roundtrip: ALL SIX smoke calls own UNIQUE container identities and every owned container was removed',
      containers.size === 6 && [...containers.values()].every((x) => x.removed === true),
      JSON.stringify({ size: containers.size }));

    const ctxPaths = contextResults.map((c) => ['noArgs', 'help', 'unknown'].flatMap((m) => {
      const inv = c.invocations?.[m];
      return [inv?.prestartReceiptPath, inv?.finalReceiptPath, inv?.tracePath];
    }));
    const allPaths = ctxPaths.flat();
    add('roundtrip: NINE per-context (prestart/final/trace x 3 modes) and EIGHTEEN total owned raw artifacts are DISTINCT',
      allPaths.length === 18 && allPaths.every((p) => typeof p === 'string' && p.length > 0) && new Set(allPaths).size === 18 && ctxPaths.every((a) => new Set(a).size === 9),
      JSON.stringify({ total: allPaths.length, unique: new Set(allPaths).size }));
    add('roundtrip: every owned raw artifact ACTUALLY exists on disk and is non-empty',
      allPaths.every((p) => existsSync(p) && statSync(p).size > 0),
      JSON.stringify(allPaths.filter((p) => !(existsSync(p) && statSync(p).size > 0))));

    add('roundtrip: the FIRST context\'s owned raw files are RETAINED byte-for-byte (the second context never overwrites them)',
      firstFiles.length === 9 && firstFiles.every((x) => existsSync(x.path) && sha256buf(readFileSync(x.path)) === x.sha256),
      JSON.stringify(firstFiles.map((x) => x.path)));

    const { artifact, emitterProblems } = buildRoundtripArtifact(root, entry, contextResults);
    add('roundtrip: the ACTUAL emitter serialised the actual-produced invocations with no emitter problems',
      emitterProblems.length === 0, JSON.stringify(emitterProblems.slice(0, 6)));
    const problems = validateSmokeEvidence(artifact, roundtripCtx(root));
    add('roundtrip: the ACTUAL independent verifier ACCEPTS the actual-produced two-context evidence with ZERO problems',
      problems.length === 0, JSON.stringify(problems.slice(0, 8)));

    const unusedManifest = join(root, 'apps', 'unused-resolver', 'package.json');
    const unusedBefore = readFileSync(unusedManifest);
    let unusedProblems;
    try {
      const changed = JSON.parse(unusedBefore.toString('utf8'));
      changed.name = '@probe/changed-unused-resolver';
      writeFileSync(unusedManifest, JSON.stringify(changed));
      unusedProblems = validateSmokeEvidence(artifact, roundtripCtx(root));
    } finally {
      writeFileSync(unusedManifest, unusedBefore);
    }
    add('roundtrip: changing an unused resolver package manifest invalidates accepted evidence',
      problems.length === 0 && unusedProblems.length > 0,
      JSON.stringify(unusedProblems.slice(0, 4)));
    add('roundtrip: restoring the unused resolver manifest restores the healthy evidence contract',
      validateSmokeEvidence(artifact, roundtripCtx(root)).length === 0);

    // (a) a MALFORMED inspected WorkingDir fails the context-bound obligation closed.
    {
      const ev = mkdtempSync(join(tmpdir(), 'cleanup-rt-bad-'));
      const bad = smokeOneContext(root, entry, obligations[0], 5000, 'owned-audit-image-unused', ev, null, { volume: 'owned-frozen-volume', completed: true, verifiedLabel: true }, 0, { spawn: roundtripSpawn({ root, ev, context: obligations[0], ctxIndex: 0, calls: [], containers: new Map(), workingDir: 'malformed' }) });
      add('roundtrip: a MALFORMED inspected WorkingDir fails the context-bound obligation closed',
        bad.status !== 'ok' && bad.invocations?.noArgs?.workingDirInspect?.reason === 'inspect-malformed',
        JSON.stringify({ status: bad.status, reason: bad.invocations?.noArgs?.workingDirInspect?.reason }));
    }
    // (b) a WRONG inspected WorkingDir (valid JSON, wrong cwd) fails closed.
    {
      const ev = mkdtempSync(join(tmpdir(), 'cleanup-rt-wrong-'));
      const bad = smokeOneContext(root, entry, obligations[0], 5000, 'owned-audit-image-unused', ev, null, { volume: 'owned-frozen-volume', completed: true, verifiedLabel: true }, 0, { spawn: roundtripSpawn({ root, ev, context: obligations[0], ctxIndex: 0, calls: [], containers: new Map(), workingDir: 'wrong' }) });
      add('roundtrip: a WRONG inspected WorkingDir (valid JSON, wrong cwd) fails closed',
        bad.status !== 'ok' && bad.invocations?.noArgs?.workingDirInspect?.reason === 'working-dir-mismatch',
        JSON.stringify({ status: bad.status, reason: bad.invocations?.noArgs?.workingDirInspect?.reason }));
    }
    // (c) failed mode aggregation: one mode with no syscall audit fails the WHOLE context.
    {
      const ev = mkdtempSync(join(tmpdir(), 'cleanup-rt-fail-'));
      const bad = smokeOneContext(root, entry, obligations[0], 5000, 'owned-audit-image-unused', ev, null, { volume: 'owned-frozen-volume', completed: true, verifiedLabel: true }, 0, { spawn: roundtripSpawn({ root, ev, context: obligations[0], ctxIndex: 0, calls: [], containers: new Map(), emptyHelpTrace: true }) });
      add('roundtrip: a single failed mode (no syscall audit) fails the WHOLE context (aggregation)',
        bad.status !== 'ok' && bad.status === 'attempt-audit-unavailable',
        JSON.stringify({ status: bad.status }));
    }
    // (d) an invalid cwd context is an explicit failed obligation with no fabricated records.
    {
      const invalid = smokeOneContext(root, entry, { ...obligations[0], valid: false, problems: ['unknown-cwd'] }, 5000, 'owned-audit-image-unused', tmpdir(), null, null, 0, { spawn: () => { throw new Error('must not spawn'); } });
      add('roundtrip: an invalid/unknown cwd is an explicit failed obligation with no fabricated invocations',
        invalid.status === 'context-invalid' && invalid.invalidContext === true && Object.keys(invalid.invocations ?? {}).length === 0,
        JSON.stringify({ status: invalid.status }));
    }
    // (e) resolver/workspace manifests are part of the canonical measured scope.
    add('roundtrip: the resolver/workspace manifests are part of the canonical measured scope',
      canonicalSmokeSpecs(root).includes('package.json') && canonicalSmokeSpecs(root).includes('pnpm-workspace.yaml') && canonicalSmokeSpecs(root).includes('apps/tools/package.json'),
      JSON.stringify(canonicalSmokeSpecs(root)));
    // (f) a reused owned raw file identity across contexts is refused by the ACTUAL verifier.
    {
      const artifact2 = structuredClone(artifact);
      const r0 = artifact2.results[0];
      const rec = JSON.parse(readFileSync(resolve(root, r0.invocationsRawPath), 'utf8'));
      rec.contexts[1].invocations.help.stdoutRawPath = rec.contexts[0].invocations.help.stdoutRawPath;
      const bytes = Buffer.from(JSON.stringify(rec));
      writeFileSync(resolve(root, r0.invocationsRawPath), bytes);
      r0.invocationsRawSha256 = sha256buf(bytes);
      add('roundtrip: a reused owned raw file identity across contexts is REFUSED by the actual verifier',
        validateSmokeEvidence(artifact2, roundtripCtx(root)).some((p) => /reuses an owned raw file identity/.test(p)),
        JSON.stringify(validateSmokeEvidence(artifact2, roundtripCtx(root)).slice(0, 4)));
    }
    // (g) multi-cwd aggregation: a failing context fails the WHOLE physical result,
    // so a harmless passing context can never mask a failing one.
    {
      const ev = mkdtempSync(join(tmpdir(), 'cleanup-rt-multicwd-'));
      const failing = smokeOneContext(root, entry, obligations[1], 5000, 'owned-audit-image-unused', ev, null, { volume: 'owned-frozen-volume', completed: true, verifiedLabel: true }, 1, { spawn: roundtripSpawn({ root, ev, context: obligations[1], ctxIndex: 1, calls: [], containers: new Map(), emptyHelpTrace: true }) });
      const ok0 = contextResults[0];
      const aggFail = aggregateContexts(entry, [ok0, failing]);
      add('roundtrip: in a multi-cwd subject a failing context fails the WHOLE physical result (a harmless passing context cannot mask it)',
        ok0.status === 'ok' && failing.status !== 'ok' && aggFail.status !== 'ok' && aggFail.status === failing.status,
        JSON.stringify({ ok: ok0.status, failing: failing.status, aggregate: aggFail.status }));
      add('roundtrip: a multi-cwd ordinary subject aggregates to `ok` only when EVERY context passed',
        contextResults.every((c) => c.status === 'ok') && aggregateContexts(entry, contextResults).status === 'ok',
        JSON.stringify({ statuses: contextResults.map((c) => c.status) }));
    }
    // (h) a healthy STATIC-FLAGGED subject is held to the SAME complete runtime
    // criteria: the actual producer runs every context, the aggregate qualifies
    // `ok` with its warning/destructive/UNSAFE-ENTRYPOINT provenance RETAINED, and
    // the actual independent verifier ACCEPTS the emitted evidence (warning kept).
    {
      const flagRoot = roundtripRepo();
      const flagEntry = { rel: 'scripts/x.mjs', subject: 'root scripts/*.mjs', kind: 'unsafe', destructive: ['rmSync', 'unlinkSync'] };
      const flagObligations = planInvocationContexts(flagRoot).contexts.filter((c) => c.rel === 'scripts/x.mjs');
      const flagReceipts = join(flagRoot, 'owned-receipts');
      mkdirSync(flagReceipts, { recursive: true });
      const prev = process.env.CLEANUP_SMOKE_RECEIPTS;
      process.env.CLEANUP_SMOKE_RECEIPTS = flagReceipts;
      let flagResults = [];
      try {
        flagResults = flagObligations.map((c, i) => {
          const ev = mkdtempSync(join(tmpdir(), 'cleanup-rt-flag-ev-'));
          return smokeOneContext(flagRoot, flagEntry, c, 5000, 'owned-audit-image-unused', ev, null, { volume: 'owned-frozen-volume', completed: true, verifiedLabel: true }, i, { spawn: roundtripSpawn({ root: flagRoot, ev, context: c, ctxIndex: i, calls: [], containers: new Map() }) });
        });
      } finally {
        if (prev === undefined) delete process.env.CLEANUP_SMOKE_RECEIPTS;
        else process.env.CLEANUP_SMOKE_RECEIPTS = prev;
      }
      const flagAgg = aggregateContexts(flagEntry, flagResults);
      add('roundtrip: a healthy static-flagged subject qualifies `ok` under the SAME runtime criteria with its warning/destructive/UNSAFE-ENTRYPOINT provenance RETAINED',
        flagResults.length > 0 && flagResults.every((c) => c.status === 'ok') && flagAgg.status === 'ok' &&
          flagAgg.packets?.includes('UNSAFE-ENTRYPOINT') && flagAgg.warnings?.includes('static-unsafe-entrypoint') &&
          flagAgg.staticRisk?.kind === 'unsafe' && flagAgg.staticRisk?.destructive?.includes('rmSync'),
        JSON.stringify({ status: flagAgg.status, packets: flagAgg.packets, warnings: flagAgg.warnings }));
      const flagBuilt = buildRoundtripArtifact(flagRoot, flagEntry, flagResults);
      const flagProbs = validateSmokeEvidence(flagBuilt.artifact, roundtripCtx(flagRoot));
      const ev0 = flagBuilt.artifact.results[0];
      add('roundtrip: the ACTUAL verifier ACCEPTS the static-flagged evidence with ZERO problems while the ACCEPTED result RETAINS its warning/provenance',
        flagBuilt.emitterProblems.length === 0 && flagProbs.length === 0 &&
          ev0.status === 'ok' && Array.isArray(ev0.warnings) && ev0.warnings.includes('static-unsafe-entrypoint') &&
          ev0.packets?.includes('UNSAFE-ENTRYPOINT') && ev0.staticRisk?.kind === 'unsafe' &&
          (ev0.contexts ?? []).every((c) => Array.isArray(c.warnings) && c.warnings.includes('static-unsafe-entrypoint')),
        JSON.stringify({ problems: flagProbs.slice(0, 6), status: ev0.status, warnings: ev0.warnings }));
    }
  } catch (err) {
    add('roundtrip: the ACTUAL integrated canonical roundtrip runs', false, `threw: ${err.message}`);
  }

  // ---- Fix-2 normal-path parity: resolveExpectedSmokeScope uses canonicalSmokeSpecs
  {
    const repo = acceptanceRepo();
    const problems = [];
    const scope = resolveExpectedSmokeScope({ root: repo }, problems);
    add('normal-path parity: resolveExpectedSmokeScope({root}) derives canonicalSmokeSpecs (incl. the selected config)',
      problems.length === 0 && scope !== null &&
      JSON.stringify(scope.specs) === JSON.stringify(canonicalSmokeSpecs(repo)) &&
      scope.specs.includes(configRel) &&
      JSON.stringify([...scope.subjects].sort((a, b) => a.path.localeCompare(b.path))) ===
        JSON.stringify([...canonicalSmokeSubjects(repo)].sort((a, b) => a.path.localeCompare(b.path))),
      JSON.stringify({ specs: scope && scope.specs, problems }));
    // The old inline union (tooling + subjects, NO config) must NOT equal the derived set.
    const legacyUnion = [...new Set(['scripts/cleanup-script-smoke', ...canonicalSmokeSubjects(repo).map((s) => s.path)])].sort();
    add('normal-path parity: the canonical spec set includes config inputs the legacy inline union omitted',
      JSON.stringify(legacyUnion) !== JSON.stringify(scope.specs) &&
      scope.specs.includes(configRel) && !legacyUnion.includes(configRel),
      JSON.stringify({ legacy: legacyUnion, canonical: scope.specs }));
  }

  // ---- fingerprint-spec parity (producer vs gate, same discovered set) ------
  try {
    const subjects = discoverEntrypoints(REPO_ROOT)
      .filter((e) => e.kind === 'entrypoint' || e.kind === 'unsafe' || e.kind === 'undiscovered-declared')
      .map((e) => e.rel);
    const producerSpecs = smokeFingerprintSpecs(subjects, selectedConfigSpecs(REPO_ROOT, subjects), declarationManifestSpecs(REPO_ROOT));
    const gateSubjects = canonicalSmokeSubjects(REPO_ROOT).map((s) => s.path);
    const gateSpecs = canonicalSmokeSpecs(REPO_ROOT);
    add('parity: producer and gate derive the SAME ordered fingerprint spec set',
      JSON.stringify(producerSpecs) === JSON.stringify(gateSpecs) && JSON.stringify([...subjects].sort()) === JSON.stringify([...gateSubjects].sort()),
      JSON.stringify({ producer: producerSpecs.length, gate: gateSpecs.length }));
  } catch (err) {
    add('parity: producer and gate derive the SAME ordered fingerprint spec set', false, `discovery failed: ${err.message}`);
  }

  // ---- committed config inputs are part of the measured scope --------------
  // The producer (`selectedConfigSpecs`, as called by the real emitter over the
  // EXECUTED subject rels) and the gate (`canonicalSmokeSpecs`) MUST derive from
  // the SAME canonical smoke subject set (entrypoint|unsafe|undiscovered-declared).
  // The previous fixture compared configs selected over EVERY finding (tests,
  // modules, non-smoke declarations) against the gate's smoke-scoped set, so a
  // config selected only for a non-smoke subject made the two sets diverge — the
  // stale expectation this fix removes. Current discovery collects the real
  // committed apps/api/tsconfig.json (the §6.2 TS subjects) and the other app
  // configs on their smoke-subject chains.
  const smokeSubjectRels = discoverEntrypoints(REPO_ROOT)
    .filter((e) => e.kind === 'entrypoint' || e.kind === 'unsafe' || e.kind === 'undiscovered-declared')
    .map((e) => e.rel);
  const configSpecs = selectedConfigSpecs(REPO_ROOT, smokeSubjectRels);
  const gateSpecs2 = canonicalSmokeSpecs(REPO_ROOT);
  add('scope: a changed committed config is IN scope (present in both spec sets)',
    configSpecs.length > 0 &&
    configSpecs.every((c) => gateSpecs2.includes(c)) &&
    smokeFingerprintSpecs([], configSpecs).every((c) => gateSpecs2.includes(c)) &&
    configSpecs.includes('apps/api/tsconfig.json'),
    JSON.stringify(configSpecs));

  // ── integrated CANONICAL-CONTEXT controls (context-evidence-controls.mjs) ──
  // Actually invoked from THIS run suite (not a new uncalled module): the real
  // canonical context planner, the smokeOneContext invalid-context obligation and
  // the crash-safe rawLogFor builder are exercised here.
  try {
    for (const c of contextEvidenceChecks()) add(c.name, c.ok, c.detail);
  } catch (err) {
    add('context-evidence-controls: run', false, String((err && err.message) || err));
  }

  // ── configuration-conditioned smoke context: ONE constant, producer/consumer ─
  // The thin CI consumer (`scripts/cleanup-gates/lib/script-contract.mjs`) MUST
  // re-export the SAME immutable context object the canonical module exposes, and
  // its `contractFor` MUST derive the configuration-conditioned contract from an
  // env-guarded source — while the generic `deriveContract(src, rel)` stays
  // conservative. This binds the producer (`run-smoke`) and the verifier to ONE
  // context so their contracts cannot drift.
  try {
    add('configguard-context: the CI consumer re-exports the SAME immutable smoke-context object',
      CONSUMER_CONTEXT === MISSING_DATABASE_URL_SMOKE_CONTEXT && Object.isFrozen(CONSUMER_CONTEXT),
      CONSUMER_CONTEXT === MISSING_DATABASE_URL_SMOKE_CONTEXT ? 'identical identity' : 'divergent identities');
    const repo = mkdtempSync(join(tmpdir(), 'cleanup-rte-cfg-'));
    mkdirSync(join(repo, 'apps', 'api', 'scripts'), { recursive: true });
    const envGuarded = [
      "import { PrismaClient } from '@prisma/client';",
      'async function main(): Promise<void> {',
      '  const prisma = new PrismaClient();',
      '  if (!process.env.DATABASE_URL) {',
      "    console.error('Usage: x requires DATABASE_URL');",
      '    process.exit(2);',
      '  }',
      '  await prisma.$disconnect();',
      '}',
      'if (require.main === module) { void main().catch(() => process.exit(1)); }',
      '',
    ].join('\n');
    writeFileSync(join(repo, 'apps', 'api', 'scripts', 'guarded.ts'), envGuarded);
    const viaConsumer = contractFor(repo, 'apps/api/scripts/guarded.ts');
    add('configguard-context: contractFor derives the configuration-conditioned contract under the named context',
      viaConsumer.noArgs.documented === true && viaConsumer.noArgs.exit === 2 && viaConsumer.noArgs.conditioned === 'missing-database-url',
      JSON.stringify(viaConsumer.noArgs));
    const generic = deriveContract(envGuarded, 'apps/api/scripts/guarded.ts');
    add('configguard-context: the consumer does NOT derive it generically (conservative default preserved)',
      generic.noArgs.documented === false, JSON.stringify(generic.noArgs));
  } catch (err) {
    add('configguard-context: the configuration-conditioned context controls run', false, `threw: ${err.message}`);
  }

  const failed = checks.filter((c) => !c.ok);
  return { module: 'runtime-evidence-controls', checks, passed: checks.length - failed.length, total: checks.length, ok: failed.length === 0 };
}

if (process.argv[1]?.endsWith('runtime-evidence-controls.mjs')) {
  const r = runRuntimeEvidenceControls();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
