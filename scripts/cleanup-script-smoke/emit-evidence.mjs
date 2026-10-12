/**
 * CleanUp1 §5.3/§6.2 — emit the schema-v4 script-smoke evidence artifact.
 *
 * Produces EXACTLY the shape the CI worker's validator
 * (`scripts/cleanup-gates/lib/smoke-evidence.mjs`, `validateSmokeEvidence`,
 * schemaVersion 4) accepts, with TWO distinct modes:
 *
 *   - committed-floor    : raw records are committed, tracked+clean, repo-relative;
 *   - owned-live-runtime : a bounded CURRENT run whose fresh PID/time raw records
 *     live under LIVE_EVIDENCE_ROOT (docs/plans/cleanup1-script-smoke-live/).
 *
 * PROVENANCE (one explicit algorithm, not a producer-supplied hash)
 * -----------------------------------------------------------------
 * `FINGERPRINT_ALGORITHM = 'sha256-ls-tree-v2'` is derived EXACTLY like CI's
 * `scripts/cleanup-gates/lib/provenance.mjs::fingerprintAt`:
 *   `git ls-tree -r <commit> -- <specs>` → sorted `path\tblob\n` lines → sha256.
 * The spec set is the SMOKE's own measured source scope (this harness dir + every
 * discovered subject) — deliberately distinct from coverage's MEASURED_SOURCE_SPECS,
 * because smoke roots/tooling are not the coverage input set. The fingerprint is
 * therefore recomputable from git ALONE at the measured commit; a manifest can
 * never be its own completeness proof. Source is verified at HEAD and each subject
 * is bound to its GIT BLOB sha256 at the measured commit (working-tree bytes that
 * differ are a hard failure — live bytes are never labelled an unrelated tree).
 *
 * TRACE BINDING
 * -------------
 * Each invocation serialises the ACTUAL per-mode parsed audit (canonical
 * `parseSyscallTrace` over THAT invocation's raw strace bytes), NOT the aggregate
 * copied into every mode. A missing/empty/invalid raw trace FAILS CLOSED. Native
 * signal/spawnError come from the actual noArgs invocation.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runSmoke, sha256hex } from './run-smoke.mjs';
import { selectSourceAppTsConfig } from './isolation.mjs';
import { planInvocationContexts } from './invocation-context.mjs';
import { packageJsons } from './discover.mjs';
import { proveBoundary } from './prove-boundary.mjs';
import {
  parseSyscallTrace,
  entrypointExecutedFromTrace,
  canonicalizeLexical,
  copyAndParseTraceFileSync,
} from './attempt-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SMOKE_EVIDENCE_SCHEMA = 'capiro.cleanup1-script-smoke-evidence';
export const SMOKE_EVIDENCE_VERSION = 5;
export const FINGERPRINT_ALGORITHM = 'sha256-ls-tree-v2';
export const LIVE_EVIDENCE_ROOT = 'docs/plans/cleanup1-script-smoke-live/';
export const FLOOR_EVIDENCE_ROOT = 'docs/plans/cleanup1-script-smoke-logs/';
export const SMOKE_TOOLING_SPEC = 'scripts/cleanup-script-smoke';
/** Resolver/workspace manifests that control invocation cwd/command resolution
 *  and MUST participate in the measured scope (a change invalidates evidence). */
export const SMOKE_RESOLVER_MANIFESTS = ['package.json', 'pnpm-workspace.yaml'];

const VALID_MODES = new Set(['owned-live-runtime', 'committed-floor']);

function git(repoRoot, args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: opts.encoding ?? 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return r;
}

function gitOrThrow(repoRoot, args) {
  const r = git(repoRoot, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return `${r.stdout ?? ''}`.trim();
}

function relPosix(repoRoot, abs) {
  return relative(repoRoot, abs).split(sep).join('/');
}

/**
 * The COMMITTED selected source-app tsconfig inputs for the given subjects — re-derived
 * from CURRENT source via the ONE canonical `selectSourceAppTsConfig`. These committed
 * config files are part of the smoke's measured source scope so a changed config is a
 * changed fingerprint. Returns sorted, unique repo-relative config paths.
 */
export function selectedConfigSpecs(repoRoot, subjectRels = []) {
  const set = new Set();
  for (const rel of subjectRels) {
    if (!rel) continue;
    try {
      const sel = selectSourceAppTsConfig(repoRoot, rel);
      if (sel.ok && sel.applicable && sel.configRel)
        set.add(String(sel.configRel).split('\\').join('/'));
    } catch {
      /* a subject whose config cannot be selected contributes nothing here */
    }
  }
  return [...set].sort();
}

/** The smoke evidence source SPEC set: harness tooling dir + every subject path + the
 *  committed selected source-app tsconfig inputs + the controlling declaration /
 *  resolver / workspace manifests (so a changed manifest that controls invocation
 *  cwd/command resolution forces a new fingerprint). Byte-identical to the gate's
 *  canonicalSmokeSpecs. */
export function smokeFingerprintSpecs(subjectRels = [], configRels = [], manifestRels = []) {
  const set = new Set([SMOKE_TOOLING_SPEC, ...SMOKE_RESOLVER_MANIFESTS]);
  for (const rel of subjectRels) if (rel) set.add(String(rel).split('\\').join('/'));
  for (const rel of configRels) if (rel) set.add(String(rel).split('\\').join('/'));
  for (const rel of manifestRels) if (rel) set.add(String(rel).split('\\').join('/'));
  return [...set].sort();
}

/**
 * The controlling declaration / resolver / workspace manifest inputs, derived
 * from the CURRENT canonical context plan (never a hardcoded count/list): EVERY
 * workspace `package.json` discovered by the canonical `packageJsons(root)` (the
 * resolver-mapping inputs), the root resolver manifests, plus every declaration's
 * owning `package.json` input. A changed manifest invalidates the evidence. Must
 * stay byte-identical to the gate's `smokeDeclarationManifestSpecs`.
 */
export function declarationManifestSpecs(root) {
  const set = new Set(SMOKE_RESOLVER_MANIFESTS);
  for (const abs of packageJsons(root)) {
    const rel = relPosix(root, abs);
    if (rel && rel !== '.' && !rel.startsWith('..') && !rel.startsWith('/')) set.add(rel);
  }
  let plan = null;
  try {
    plan = planInvocationContexts(root);
  } catch {
    plan = null;
  }
  for (const c of plan?.contexts ?? []) {
    for (const m of c.manifestInputs ?? []) {
      if (m && typeof m.rel === 'string' && m.rel) set.add(String(m.rel).split('\\').join('/'));
    }
  }
  return [...set].sort();
}

/**
 * Recompute `sha256-ls-tree-v2` from git at `commitSha` over explicit path specs.
 * Byte-identical to CI's provenance.fingerprintAt (sorted `path\tblob\n`, sha256).
 */
export function fingerprintAt(repoRoot, commitSha, specs) {
  const list = Array.isArray(specs) && specs.length ? specs : smokeFingerprintSpecs([]);
  const res = git(repoRoot, ['ls-tree', '-r', commitSha, '--', ...list]);
  if (res.error) return { ok: false, fingerprint: null, entries: null, error: res.error.message };
  if (res.status !== 0) {
    return {
      ok: false,
      fingerprint: null,
      entries: null,
      error: `${res.stderr ?? ''}`.trim() || `git ls-tree exited ${res.status}`,
    };
  }
  const entries = `${res.stdout ?? ''}`
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, p] = line.split('\t');
      const blob = String(meta).split(/\s+/)[2];
      return { path: p, blob };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const h = createHash('sha256');
  for (const e of entries) h.update(`${e.path}\t${e.blob}\n`);
  return { ok: true, fingerprint: h.digest('hex'), entries, error: null };
}

/** Back-compat convenience: fingerprint the harness + subject set at HEAD. */
export function measuredFingerprint(repoRoot, rels) {
  const sha = headSha(repoRoot);
  const fp = fingerprintAt(
    repoRoot,
    sha,
    smokeFingerprintSpecs(
      rels,
      selectedConfigSpecs(repoRoot, rels),
      declarationManifestSpecs(repoRoot),
    ),
  );
  return fp.ok ? fp.fingerprint : null;
}

export function headSha(repoRoot) {
  const r = git(repoRoot, ['rev-parse', 'HEAD']);
  return r.status === 0 ? `${r.stdout ?? ''}`.trim() : null;
}

export function commitExists(repoRoot, sha) {
  return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).status === 0;
}

/** sha256 of the committed git blob for `rel` at `sha` (null when absent). */
export function gitBlobSha256(repoRoot, sha, rel) {
  const r = git(repoRoot, ['show', `${sha}:${rel}`], { encoding: 'buffer' });
  if (r.status !== 0) return null;
  return createHash('sha256')
    .update(r.stdout ?? Buffer.alloc(0))
    .digest('hex');
}

/** True iff `rel` is tracked and byte-identical to its committed HEAD blob. */
export function gitTrackedClean(repoRoot, rel) {
  if (git(repoRoot, ['ls-files', '--error-unmatch', '--', rel]).status !== 0)
    return { tracked: false, clean: false };
  const diff = git(repoRoot, ['diff', '--quiet', 'HEAD', '--', rel]);
  return { tracked: true, clean: diff.status === 0 };
}

const slugify = (rel) => rel.replace(/[^A-Za-z0-9._-]+/g, '__');

const toJson = (obj) => JSON.stringify(obj, null, 2) + '\n';
const sha256bytes = (s) => createHash('sha256').update(s).digest('hex');

/** Reject absolute / traversal / symlink-escaping paths; return a clean repo-rel path. */
export function ownedRepoRel(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  const norm = p.split('\\').join('/');
  if (/^[A-Za-z]:/.test(norm) || norm.startsWith('/')) return null;
  const canon = canonicalizeLexical(norm);
  if (!canon || canon === '.' || canon.startsWith('..')) return null;
  if (canon.split('/').includes('..')) return null;
  return canon;
}

/**
 * Resolve a repo-relative output directory, REFUSING any symlinked path
 * component and any real path that escapes the repository root. Creates it only
 * after the containment check (lexical checks alone do not stop a symlink).
 */
export function containedOutputDir(repoRoot, relDir) {
  const rootReal = realpathSync(repoRoot);
  const relClean = String(relDir).replace(/\\/g, '/').replace(/\/+$/, '');
  let cur = rootReal;
  for (const seg of relClean.split('/').filter(Boolean)) {
    cur = join(cur, seg);
    if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) {
      throw new Error(`output path component is a symlink (refused): ${cur}`);
    }
  }
  mkdirSync(cur, { recursive: true });
  const real = realpathSync(cur);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error(`output dir escapes the repository root (refused): ${real}`);
  }
  return real;
}

/**
 * Write one raw file under the repo-relative root. `used` enforces a unique,
 * collision-free name set so two distinct subjects/modes can never flatten to
 * the same file; the exclusive `wx` flag additionally refuses to OVERWRITE a
 * prior-run artifact.
 */
function writeRaw(repoRoot, relDir, name, content, used) {
  if (used.has(name)) throw new Error(`raw-evidence name collision refused: ${name}`);
  used.add(name);
  const abs = join(repoRoot, relDir, name);
  mkdirSync(dirname(abs), { recursive: true });
  const text = typeof content === 'string' || Buffer.isBuffer(content) ? content : toJson(content);
  writeFileSync(abs, text, { flag: 'wx' });
  return { path: `${relDir}${name}`, sha256: sha256bytes(text) };
}

/** Reserve a unique, collision-free raw name (two subjects/contexts/modes can never
 *  flatten to the same file). */
function reserveName(used, name) {
  if (used.has(name)) throw new Error(`raw-evidence name collision refused: ${name}`);
  used.add(name);
}

/**
 * Stream a raw strace trace into an OWNED raw file WITH bounded buffers through
 * the ONE canonical `copyAndParseTraceFileSync` — never a whole-file
 * `readFileSync`/`toString`/`parseSyscallTrace`. Returns the parsed arrays, the
 * EXACT copied byte count and its sha256, or null (with a recorded problem) when
 * the trace is missing/empty/unreadable.
 */
function streamTrace(repoRoot, relDir, name, srcPath, used, problems, label) {
  const abs = join(repoRoot, relDir, name);
  mkdirSync(dirname(abs), { recursive: true });
  reserveName(used, name);
  let res;
  try {
    res = copyAndParseTraceFileSync(srcPath, abs);
  } catch (e) {
    problems.push(`${label}: strace trace could not be streamed (${e.message})`);
    return null;
  }
  if (res.bytes === 0)
    problems.push(`${label}: missing/empty strace trace — not a conforming executed invocation`);
  return { path: `${relDir}${name}`, sha256: res.sha256, bytes: res.bytes, parsed: res };
}

/** Persist the EXACT lifecycle receipt bytes (small JSON) under the owned raw
 *  root and hash them. A missing/unreadable receipt is a recorded problem. */
function persistReceipt(repoRoot, relDir, name, srcPath, used, problems, label) {
  if (!srcPath) {
    problems.push(`${label}: lifecycle receipt ${name} is missing`);
    return null;
  }
  let bytes;
  try {
    bytes = readFileSync(srcPath);
  } catch (e) {
    problems.push(`${label}: lifecycle receipt unreadable (${e.message})`);
    return null;
  }
  const abs = join(repoRoot, relDir, name);
  mkdirSync(dirname(abs), { recursive: true });
  reserveName(used, name);
  writeFileSync(abs, bytes, { flag: 'wx' });
  return { path: `${relDir}${name}`, sha256: sha256bytes(bytes) };
}

/**
 * Serialise ONE canonical context's three invocations into owned raw files: the
 * stdout/stderr, the STREAMED raw strace text (+ its parsed JSON), and the EXACT
 * prestart/final lifecycle receipt bytes. Every raw record carries its byte
 * sha256; the per-invocation parsed audit is THIS invocation's OWN audit.
 */
function buildContextRecord(repoRoot, relDir, r, ctxRes, ctxIndex, used, problems) {
  const slug = slugify(r.rel);
  const cslug = `${slug}.ctx${ctxIndex}`;
  const invs = {};
  for (const key of ['noArgs', 'help', 'unknown']) {
    const inv = ctxRes.invocations?.[key];
    if (!inv) {
      problems.push(`${r.rel} ${ctxRes.contextKey} ${key}: invocation was not recorded`);
      continue;
    }
    const label = `${r.rel} ${ctxRes.contextKey} ${key}`;
    const stdout = writeRaw(repoRoot, relDir, `${cslug}.${key}.stdout`, inv.out ?? '', used);
    const stderr = writeRaw(repoRoot, relDir, `${cslug}.${key}.stderr`, inv.err ?? '', used);
    const streamed = streamTrace(
      repoRoot,
      relDir,
      `${cslug}.${key}.trace.txt`,
      inv.tracePath ?? join(r.evidenceDir, inv.traceName),
      used,
      problems,
      label,
    );
    const parsed = streamed ? streamed.parsed : { network: [], write: [], permittedWrites: [] };
    const parsedTrace = {
      attemptedNetwork: parsed.network,
      attemptedWrites: parsed.write,
      attemptedOther: [],
    };
    const traceJson = writeRaw(repoRoot, relDir, `${cslug}.${key}.trace.json`, parsedTrace, used);
    const pre = persistReceipt(
      repoRoot,
      relDir,
      `${cslug}.${key}.prestart.json`,
      inv.prestartReceiptPath,
      used,
      problems,
      label,
    );
    const fin = persistReceipt(
      repoRoot,
      relDir,
      `${cslug}.${key}.final.json`,
      inv.finalReceiptPath,
      used,
      problems,
      label,
    );
    invs[key] = {
      argv: inv.argv,
      exit: inv.exit,
      signal: inv.signal ?? null,
      spawnError: inv.spawnError ?? null,
      timedOut: inv.timedOut === true,
      // The EXACT bound runtime plan (config/loader/context) thread — the gate
      // independently re-derives the expected plan and refuses a mismatch rather
      // than trusting these fields as their own proof.
      runtimeConfig: inv.runtimeConfig ?? null,
      runtimeConfigRel: inv.runtimeConfigRel ?? null,
      tsxLoader: inv.tsxLoader ?? null,
      runtimeContext: inv.runtimeContext ?? null,
      // Canonical context binding: the exact context key, declared cwd, and the
      // absolute native subject + actual inspected cwd the run was bound to.
      contextKey: inv.contextKey ?? ctxRes.contextKey,
      cwdRel: inv.cwdRel ?? ctxRes.cwdRel,
      nativeCwd: inv.nativeCwd ?? null,
      nativeSubject: inv.nativeSubject ?? null,
      containerId: inv.containerId ?? null,
      workingDirInspect: inv.workingDirInspect ?? null,
      // Subject-bound proof: the trace must show the EXACT absolute native subject
      // (never a foreign same-suffix path) + THIS mode's args.
      entrypointExecuted: entrypointExecutedFromTrace(parsed, {
        subject: r.rel,
        args: inv.args ?? [],
        runtimeConfig: inv.runtimeConfig ?? null,
        loader: inv.tsxLoader ?? null,
        nativeSubject: inv.nativeSubject ?? null,
      }),
      usagePrinted: inv.usagePrinted === true,
      // The invocation's OWN parsed audit (CI compares traceRawPath to this).
      audit: parsedTrace,
      stdoutRawPath: stdout.path,
      stdoutRawSha256: stdout.sha256,
      stderrRawPath: stderr.path,
      stderrRawSha256: stderr.sha256,
      traceRawPath: traceJson.path,
      traceRawSha256: traceJson.sha256,
      traceTextRawPath: streamed ? streamed.path : null,
      traceTextRawSha256: streamed ? streamed.sha256 : null,
      traceTextBytes: streamed ? streamed.bytes : 0,
      prestartRawPath: pre ? pre.path : null,
      prestartRawSha256: pre ? pre.sha256 : null,
      finalRawPath: fin ? fin.path : null,
      finalRawSha256: fin ? fin.sha256 : null,
    };
  }
  return {
    contextKey: ctxRes.contextKey,
    rel: ctxRes.rel,
    cwdRel: ctxRes.cwdRel,
    kind: ctxRes.kind,
    declarationRefs: ctxRes.declarationRefs ?? [],
    declarations: ctxRes.declarations ?? [],
    manifestInputs: ctxRes.manifestInputs ?? [],
    fingerprint: ctxRes.fingerprint ?? null,
    status: ctxRes.status,
    reasons: ctxRes.reasons ?? [],
    // Retained static provenance (a static-flagged subject that qualified carries
    // its warning / destructive findings / UNSAFE-ENTRYPOINT packet here; an
    // ordinary subject carries none). Additive — the schema-v5 shape is unchanged.
    ...(Array.isArray(ctxRes.packets) && ctxRes.packets.length ? { packets: ctxRes.packets } : {}),
    ...(Array.isArray(ctxRes.warnings) && ctxRes.warnings.length
      ? { warnings: ctxRes.warnings }
      : {}),
    invocations: invs,
  };
}

/** The summary-level context projection (keys + provenance the result declares). */
function contextSummary(ctxRec) {
  return {
    contextKey: ctxRec.contextKey,
    rel: ctxRec.rel,
    cwdRel: ctxRec.cwdRel,
    kind: ctxRec.kind,
    declarationRefs: ctxRec.declarationRefs,
    manifestInputs: ctxRec.manifestInputs,
    fingerprint: ctxRec.fingerprint,
    ...(Array.isArray(ctxRec.packets) && ctxRec.packets.length ? { packets: ctxRec.packets } : {}),
    ...(Array.isArray(ctxRec.warnings) && ctxRec.warnings.length
      ? { warnings: ctxRec.warnings }
      : {}),
  };
}

/**
 * Map an audited smoke result to the schema-v5 per-result shape. Every canonical
 * context is serialised (one physical result identity, explicit context results);
 * the raw invocation record carries the COMPLETE per-context invocations. The
 * parsed noArgs trace produced while streaming is REUSED for the result audit —
 * it is never re-read.
 */
export function toEvidenceResult(repoRoot, relDir, r, used, problems, sourceSha256) {
  const subjectRel = typeof r?.rel === 'string' && r.rel ? r.rel : `__missing_subject_${used.size}`;
  if (subjectRel !== r?.rel)
    problems.push(`smoke result has no subject path (status=${r?.status ?? 'missing'})`);
  if (r?.status !== 'ok' && !r?.noArgs) {
    problems.push(
      `${subjectRel}: nonpassing smoke result ${r?.status ?? 'missing'}: ${(r?.reasons ?? []).join('; ')}`,
    );
  }
  const contextResults = Array.isArray(r.contextResults) ? r.contextResults : [];
  const ctxRecords = contextResults.map((c, i) =>
    buildContextRecord(repoRoot, relDir, r, c, i, used, problems),
  );
  const invRecObj = {
    subject: r.rel ?? null,
    sourceSha256: sourceSha256 ?? null,
    contexts: ctxRecords,
    // Back-compat anchor: the FIRST canonical context's invocations (the primary
    // result identity). The complete set lives under `contexts`.
    invocations: ctxRecords[0]?.invocations ?? {},
  };
  const inv = writeRaw(
    repoRoot,
    relDir,
    `${slugify(subjectRel)}.invocations.json`,
    invRecObj,
    used,
  );
  // The primary (noArgs) invocation's OWN parsed audit anchors the result audit.
  const noArgsInv = ctxRecords[0]?.invocations?.noArgs;
  const noArgsAudit = noArgsInv?.audit ?? null;
  if (!noArgsInv)
    problems.push(`${subjectRel}: no primary context noArgs invocation for the result audit`);
  const auditRec = noArgsAudit
    ? writeRaw(repoRoot, relDir, `${slugify(subjectRel)}.audit.json`, noArgsAudit, used)
    : null;
  const noArgs = r.noArgs && typeof r.noArgs === 'object' ? r.noArgs : null;
  if (!noArgs) problems.push(`${subjectRel}: noArgs execution was not recorded`);
  const helpRun = r.help && typeof r.help === 'object' ? r.help : null;
  if (r.contract?.help?.supported && !helpRun)
    problems.push(`${subjectRel}: supported help execution was not recorded`);
  const help = r.contract?.help?.supported
    ? {
        supported: true,
        exit: helpRun?.exit ?? null,
        usagePrinted: helpRun?.usagePrinted === true,
        timedOut: helpRun?.timedOut === true,
      }
    : { supported: false };
  return {
    path: subjectRel,
    subject: r.subject,
    status: r.status ?? 'missing-result',
    reasons: Array.isArray(r.reasons) ? r.reasons : [],
    sourceSha256: sourceSha256 ?? null,
    // Retained static provenance on an ACCEPTED static-flagged result: the
    // discovery warning / destructive findings / UNSAFE-ENTRYPOINT packet travel
    // with the qualified result. Additive — the schema-v5 shape is unchanged.
    ...(Array.isArray(r.packets) && r.packets.length ? { packets: r.packets } : {}),
    ...(Array.isArray(r.warnings) && r.warnings.length ? { warnings: r.warnings } : {}),
    ...(r.staticRisk ? { staticRisk: r.staticRisk } : {}),
    contract: r.contract ?? null,
    noArgs: {
      exit: noArgs?.exit ?? null,
      usagePrinted: noArgs ? noArgs.usagePrinted === true : null,
      timedOut: noArgs ? noArgs.timedOut === true : null,
    },
    help,
    audit: noArgsAudit,
    native: {
      argv: noArgsInv?.argv ?? null,
      exit: noArgs?.exit ?? null,
      signal: noArgsInv?.signal ?? null,
      spawnError: noArgsInv?.spawnError ?? null,
    },
    rawLogPath: r.rawLogPath ?? null,
    rawLogSha256: r.rawLogSha256 ?? null,
    auditRawPath: auditRec?.path ?? null,
    auditRawSha256: auditRec?.sha256 ?? null,
    invocationsRawPath: inv.path,
    invocationsRawSha256: inv.sha256,
    // The complete canonical context set this result declares (each independently
    // validated by the gate against CURRENT source — producer assertions are not
    // the source of truth).
    contexts: ctxRecords.map(contextSummary),
  };
}

/** Build the isolation block + its parsed self-test raw record. */
export function isolationFromProof(repoRoot, relDir, proof, used, problems) {
  const netCheck = (proof.checks ?? []).find((c) => /denied network attempt/i.test(c.name) && c.ok);
  const writeCheck = (proof.checks ?? []).find(
    (c) => /denied read-only-tree write/i.test(c.name) && c.ok,
  );
  const netTarget = '127.0.0.1:9';
  const writeTarget = 'read-only staged source tree';
  const networkAttempts = netCheck
    ? [{ subject: 'containment-selftest', kind: 'network', target: netTarget, denied: true }]
    : [];
  const writeAttempts = writeCheck
    ? [
        {
          subject: 'containment-selftest',
          kind: 'host-file-write',
          target: writeTarget,
          denied: true,
        },
      ]
    : [];
  if (!netCheck) problems.push('isolation proof did not exercise a denied network attempt');
  if (!writeCheck) problems.push('isolation proof did not exercise a denied host write');
  const selfTest = {
    subject: 'containment-selftest',
    network: { target: netTarget, denied: networkAttempts.length > 0 },
    write: { target: writeTarget, denied: writeAttempts.length > 0 },
  };
  const written = writeRaw(repoRoot, relDir, 'isolation-selftest.json', selfTest, used);
  return {
    networkDenied: proof.ok === true && networkAttempts.length > 0,
    hostWriteDenied: proof.ok === true && writeAttempts.length > 0,
    mechanism:
      proof.sandbox ??
      'docker node:22-alpine --network none --read-only (+ strace -f -yy -e %network,%file,%desc)',
    selfTestRawPath: written.path,
    selfTestRawSha256: written.sha256,
    proof: { exercised: proof.ok === true, networkAttempts, writeAttempts },
  };
}

/** Validate the emitter CLI surface up front (reject unbounded/invalid inputs). */
export function validateEmitArgs(repoRoot, opts) {
  const problems = [];
  const { mode, timeoutMs, limit, out, logDir } = opts;
  if (!VALID_MODES.has(mode))
    problems.push(
      `invalid --mode ${JSON.stringify(mode)} (expected ${[...VALID_MODES].join('|')})`,
    );
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    problems.push(
      `--timeout-ms must be an integer in [1000,600000] (got ${JSON.stringify(timeoutMs)})`,
    );
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    problems.push(`--limit must be a positive integer (got ${JSON.stringify(limit)})`);
  }
  for (const [flag, value] of [
    ['--out', out],
    ['--log-dir', logDir],
  ]) {
    if (value === undefined || value === null) continue;
    if (!ownedRepoRel(value))
      problems.push(
        `${flag} must be a repo-relative, non-escaping path (got ${JSON.stringify(value)})`,
      );
  }
  if (!repoRoot || !existsSync(join(repoRoot, '.git')))
    problems.push(`--root ${JSON.stringify(repoRoot)} is not a git repository`);
  return problems;
}

export function emitEvidence(
  repoRoot,
  {
    out,
    logDir,
    timeoutMs = 30000,
    mode = 'owned-live-runtime',
    commitSha,
    limit,
    subjectDeps = null,
  } = {},
) {
  const argProblems = validateEmitArgs(repoRoot, { mode, timeoutMs, limit, out, logDir });
  if (argProblems.length) {
    return {
      ok: false,
      artifact: null,
      target: null,
      problems: argProblems,
      report: null,
      proof: null,
    };
  }

  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const baseDir = mode === 'committed-floor' ? (logDir ?? FLOOR_EVIDENCE_ROOT) : LIVE_EVIDENCE_ROOT;
  // Unique per-invocation output directory under the owned base (never overwrite a
  // prior run). Refuse symlinked components / real-path escape, fail closed.
  let relDir;
  try {
    containedOutputDir(repoRoot, `${String(baseDir).replace(/\/+$/, '')}/run-${runId}`);
    relDir = `${String(baseDir).replace(/\/+$/, '')}/run-${runId}/`;
  } catch (error) {
    return {
      ok: false,
      artifact: null,
      target: null,
      problems: [`output dir rejected: ${error.message}`],
      report: null,
      proof: null,
    };
  }
  const sha = commitSha ?? headSha(repoRoot);
  const absRaw = join(repoRoot, relDir);

  const report = runSmoke(repoRoot, {
    timeoutMs,
    rawLogDir: absRaw,
    repoRelBase: relDir.replace(/\/+$/, ''),
    limit,
    subjectDeps,
  });
  const proof = proveBoundary(repoRoot, { timeoutMs: Math.min(timeoutMs, 20000) });

  const problems = [];
  // Provenance: source must be at HEAD (no movement) and each subject must be a
  // clean committed blob at the measured commit.
  const head = headSha(repoRoot);
  if (!commitExists(repoRoot, sha)) problems.push(`commit ${sha} does not exist`);
  if (sha !== head)
    problems.push(`source commit ${sha} is not HEAD ${head} — source movement is rejected`);
  const rels = (report.results ?? []).map((r) => r.rel).filter(Boolean);
  const specs = smokeFingerprintSpecs(
    rels,
    selectedConfigSpecs(repoRoot, rels),
    declarationManifestSpecs(repoRoot),
  );
  const fp = fingerprintAt(repoRoot, sha, specs);
  if (!fp.ok)
    problems.push(
      `smoke fingerprint (${FINGERPRINT_ALGORITHM}) could not be recomputed: ${fp.error}`,
    );

  const sourceShaByRel = new Map();
  for (const rel of rels) {
    const tc = gitTrackedClean(repoRoot, rel);
    if (!tc.tracked) problems.push(`subject ${rel} is not a tracked committed file`);
    else if (!tc.clean)
      problems.push(`subject ${rel} working tree differs from HEAD — dirty source rejected`);
    const blob = gitBlobSha256(repoRoot, sha, rel);
    if (!blob) problems.push(`subject ${rel} is not present at ${sha}`);
    else sourceShaByRel.set(rel, blob);
  }

  const used = new Set();
  const results = (report.results ?? []).map((r) =>
    toEvidenceResult(repoRoot, relDir, r, used, problems, sourceShaByRel.get(r.rel) ?? null),
  );
  const rawLogHashes = {};
  for (const r of results) if (r.path && r.rawLogSha256) rawLogHashes[r.path] = r.rawLogSha256;

  const isolation = isolationFromProof(repoRoot, relDir, proof, used, problems);

  const artifact = {
    schema: SMOKE_EVIDENCE_SCHEMA,
    schemaVersion: SMOKE_EVIDENCE_VERSION,
    generatedAt: new Date().toISOString(),
    mode,
    run: { complete: report.partial !== true, partial: report.partial === true },
    source: {
      commitSha: sha,
      fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
      fingerprint: fp.ok ? fp.fingerprint : null,
      specs,
    },
    discovery: {
      subjects: (report.results ?? []).map((r) => ({ path: r.rel, source: r.subject })),
      count: results.length,
    },
    isolation,
    results,
    rawLogHashes,
  };

  const allOk =
    problems.length === 0 &&
    results.length > 0 &&
    results.every((r) => r.status === 'ok') &&
    artifact.run.complete === true &&
    artifact.isolation.proof.exercised;

  const defaultOut = join(relDir, 'cleanup1-script-smoke-evidence.json');
  const target = (out ?? defaultOut).replace(/\.json$/, allOk ? '.json' : '.diagnostic.json');
  const absTarget =
    /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('/') ? target : join(repoRoot, target);
  mkdirSync(dirname(absTarget), { recursive: true });
  // Keep the exact runtime setup return and bounded receipt bytes in diagnostics.
  // A setup refusal is never promoted into the accepted schema artifact.
  const outArtifact = allOk
    ? artifact
    : {
        ...artifact,
        problems,
        ...(report.runtimeSetup ? { runtimeSetup: report.runtimeSetup } : {}),
      };
  writeFileSync(absTarget, toJson(outArtifact));
  return { ok: allOk, artifact: outArtifact, target: absTarget, problems, report, proof };
}

if (process.argv[1]?.endsWith('emit-evidence.mjs')) {
  const args = process.argv.slice(2);
  const get = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : def;
  };
  const root = get('--root', process.cwd());
  const mode = get('--mode', 'owned-live-runtime');
  const out = get('--out', undefined);
  const logDir = get('--log-dir', undefined);
  const limitRaw = get('--limit', undefined);
  const timeoutRaw = get('--timeout-ms', '30000');
  const r = emitEvidence(root, {
    out,
    logDir,
    timeoutMs: Number(timeoutRaw),
    mode,
    limit: limitRaw === undefined ? undefined : Number(limitRaw),
  });
  process.stdout.write(
    JSON.stringify(
      {
        ok: r.ok,
        target: r.target,
        problems: r.problems,
        results: r.artifact?.results?.length ?? 0,
        counts: r.report?.counts,
        isolationExercised: r.artifact?.isolation?.proof?.exercised,
      },
      null,
      2,
    ) + '\n',
  );
  process.exitCode = r.ok ? 0 : 1;
}
