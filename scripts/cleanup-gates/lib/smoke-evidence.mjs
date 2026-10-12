import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { entrypointExecutedFromTrace } from '../../cleanup-script-smoke/attempt-audit.mjs';
import { discoverEntrypoints, packageJsons } from '../../cleanup-script-smoke/discover.mjs';
import { selectSourceAppTsConfig } from '../../cleanup-script-smoke/isolation.mjs';
import { planInvocationContexts, nativeCwdFor, normalizeRel } from '../../cleanup-script-smoke/invocation-context.mjs';
// The ONE committed TS-runtime CLI constant (`node_modules/tsx/dist/cli.mjs`): the
// native-bind loader identity is DERIVED from this exported constant, never a
// wildcard regex that would accept an arbitrary `/tsruntime/.../tsx/dist/cli.mjs`.
import { TS_RUNTIME_CLI_REL } from '../../cleanup-script-smoke/ts-runtime.mjs';
/** The EXACT controlled native-bind tsx loader inside the read-only /tsruntime volume. */
export const TS_RUNTIME_BOUND_LOADER = `/tsruntime/${TS_RUNTIME_CLI_REL}`;

/**
 * Complete, fail-closed contract for the script-smoke evidence artifact
 * (CleanUp1 §5.3 / §6.2; independent review rounds 3, 4 and 5).
 *
 * History:
 *   - v1 accepted failed/forged evidence with ZERO problems (existence checks).
 *   - v2 added type/shape checks but STILL accepted a fixture with `partial:true`,
 *     an invented fingerprint, a nonexistent entrypoint and an uninvented hash.
 *   - v3 re-derived source/fingerprint/discovery from CURRENT source and hashed
 *     committed raw bytes — but root round 5 independently reproduced v3
 *     accepting a FABRICATED record: arbitrary tracked raw TEXT, a tracked
 *     NON-JSON "audit", invented isolation denials, an UNEXECUTED help, a native
 *     exit99 inconsistent with noArgs exit2, and `entrypointExecuted:false`, all
 *     with zero problems. Hashing arbitrary committed bytes does not establish
 *     native execution: a hash proves byte identity, not that the bytes are a
 *     native invocation record.
 *
 * v4 (this contract) binds every result to its PARSED raw invocation/audit
 * record. The raw records are committed repo-relative JSON files whose bytes are
 * hashed AND parsed; the parsed contents must be internally consistent, must
 * carry BOTH the no-arguments and the --help invocation identities, must prove
 * the entry point actually executed (`entrypointExecuted:true`), and must agree
 * exactly with the summary fields the artifact declares (argv, exit, signal,
 * spawn error, timeout, usage, attempts). Missing audit or missing execution is
 * a hard failure. The isolation proof must likewise reference a parsed raw
 * self-test record showing the denials were exercised.
 *
 * Round-6 corrections (schema stays v4): a `--help` invocation whose argv never
 * names the entrypoint is rejected (the previous argv test fell through);
 * summary↔raw usage/timeout fields are compared in BOTH directions; and each
 * native invocation must bind its actual committed raw stdout/stderr/trace bytes
 * (the trace parsed and equal to the result audit), so a summary cannot be
 * fabricated without a matching run.
 *
 * The consumer (the gate) passes a `ctx` object; every re-derivation the
 * validator needs must come from it, and any missing capability fails closed:
 *
 *   root                       absolute repo root
 *   resolve(p)                 -> absolute path for a repo-relative path
 *   existsSync(p)              -> boolean
 *   sha256File(p)              -> hex sha256 of a file's bytes
 *   readFile(p)                -> utf8 contents
 *   commitExists(sha)          -> boolean (real commit in this repo)
 *   isAncestorOfHead(sha)      -> boolean (ancestor of / equal to HEAD)
 *   fingerprintAlgorithm       supported fingerprint algorithm id (string)
 *   fingerprintAt(sha)         -> {ok, fingerprint} | {ok:false,error} (recompute)
 *   contractFor(path)          -> documented per-entrypoint contract (derived)
 *   sourceShaAt(path, sha)     -> hex sha256 of the entrypoint source AT sha
 *   trackedAndClean(relPath)   -> {tracked, clean} (committed + unmodified)
 *   contained(relPath)         -> boolean (repo-relative, inside root)
 *
 * Round 30 changed the scope inputs: the expected smoke subject/spec set is NO
 * LONGER a caller-supplied list (a divergent CI copy). The validator re-derives
 * it from CURRENT source via the ONE canonical discovery module
 * (`../cleanup-script-smoke/discover.mjs`) using `ctx.root`. A caller may inject
 * a `smokeScope()` seam (used only by unit tests with a synthetic root); when
 * neither the seam nor `ctx.root` is available the scope check FAILS CLOSED.
 */

export const SMOKE_EVIDENCE_SCHEMA = 'capiro.cleanup1-script-smoke-evidence';
export const SMOKE_EVIDENCE_VERSION = 5;

/**
 * Owned root for LIVE (current-invocation) raw artifacts (review round 8). A
 * bounded `owned-live-runtime` run produces fresh PID/time artifacts that are
 * NOT committed+clean yet; those are permitted ONLY under this owned directory.
 * The immutable committed-floor mode keeps the strict tracked+clean requirement.
 */
export const LIVE_EVIDENCE_ROOT = 'docs/plans/cleanup1-script-smoke-live/';

/** The ONE smoke tooling spec the canonical fingerprint scope always includes
 *  (the emitter's `SMOKE_TOOLING_SPEC`). */
export const SMOKE_TOOLING_SPEC = 'scripts/cleanup-script-smoke';
/** Resolver/workspace manifests that control invocation cwd/command resolution
 *  (the emitter's `SMOKE_RESOLVER_MANIFESTS`). */
export const SMOKE_RESOLVER_MANIFESTS = ['package.json', 'pnpm-workspace.yaml'];
/** The single unknown-flag token the smoke run supplies (mirrors run-smoke.mjs). */
export const SMOKE_UNKNOWN_FLAG = '--cleanup-smoke-unknown-flag';

/** Repo-relative POSIX normalization, or null when `abs` escapes `root`. */
function containedRepoRel(root, abs) {
  let r;
  try {
    r = relative(root, abs).split(sep).join('/');
  } catch {
    return null;
  }
  if (!r || r === '' || r === '.' || r.startsWith('..') || r.startsWith('/')) return null;
  return r;
}

/** The controlling declaration / resolver / workspace manifest inputs, re-derived
 *  from the CURRENT canonical context plan (byte-identical to the emitter's
 *  `declarationManifestSpecs`).
 *
 *  Round 35: the scope binds ALL current canonical-discovery `packageJsons(root)`
 *  resolver-mapping inputs (EVERY workspace `package.json`, discovered — never a
 *  fixed count/list), plus the root resolver manifests (`package.json`,
 *  `pnpm-workspace.yaml`) and every declaration's owning-manifest input from the
 *  canonical context plan. `resolveDeclaredTargets` does NOT return `packageJsons`,
 *  so it is derived here directly. Derivation FAILS CLOSED (throws) rather than
 *  silently degrading to a root-only set: a change to any controlling manifest
 *  invalidates the evidence. */
export function smokeDeclarationManifestSpecs(root) {
  const set = new Set(SMOKE_RESOLVER_MANIFESTS);
  // Every workspace package.json, discovered dynamically (root first).
  for (const abs of packageJsons(root)) {
    const rel = containedRepoRel(root, abs);
    if (rel) set.add(rel);
  }
  const plan = planInvocationContexts(root);
  for (const c of plan.contexts) {
    for (const m of c.manifestInputs ?? []) if (m && typeof m.rel === 'string' && m.rel) set.add(String(m.rel).split('\\').join('/'));
  }
  return [...set].sort();
}

/**
 * The canonical §6.2 smoke subject set, re-derived from CURRENT source by the
 * ONE canonical discovery module owned by the execution lane
 * (`scripts/cleanup-script-smoke/discover.mjs`) — never a divergent CI copy
 * (round-30 alignment: "no divergent CI copies").
 *
 * The scope is the emitter's EXECUTED + terminal-packet kinds
 * (`entrypoint` | `unsafe` | `undiscovered-declared`): helpers/tests are
 * excluded, and `unsafe` / `undiscovered-declared` packets stay IN scope. A
 * static-flagged (`unsafe`) subject is NOT excluded and is executed under the
 * SAME complete runtime acceptance criteria as an ordinary entrypoint: when it
 * meets every actual criterion it qualifies `ok` with its static warning /
 * destructive findings / UNSAFE-ENTRYPOINT provenance RETAINED (a static warning
 * never substitutes for execution/proof/acceptance). A genuine runtime failure,
 * or an `undiscovered-declared` declaration, remains a non-`ok` failure.
 */
export function canonicalSmokeSubjects(root) {
  return discoverEntrypoints(root)
    .filter((e) => e.kind === 'entrypoint' || e.kind === 'unsafe' || e.kind === 'undiscovered-declared')
    .map((e) => ({ path: e.rel, source: e.subject }));
}

/** The canonical smoke fingerprint scope (tooling dir + every subject path + the
 *  committed selected source-app tsconfig inputs), byte-identical to the emitter's
 *  `smokeFingerprintSpecs` over the SAME discovered subject set. */
export function canonicalSmokeSpecs(root) {
  const subjects = canonicalSmokeSubjects(root);
  const configRels = [];
  for (const s of subjects) {
    try {
      const sel = selectSourceAppTsConfig(root, s.path);
      if (sel.ok && sel.applicable && sel.configRel) configRels.push(String(sel.configRel).split('\\').join('/'));
    } catch {
      /* an unselectable subject contributes no config input */
    }
  }
  return [...new Set([SMOKE_TOOLING_SPEC, ...SMOKE_RESOLVER_MANIFESTS, ...subjects.map((s) => s.path), ...configRels, ...smokeDeclarationManifestSpecs(root)])].sort();
}

/**
 * The canonical per-subject context set, re-derived from CURRENT source by the ONE
 * canonical context planner (never a producer-supplied list). Returns a Map from
 * subject rel to its sorted array of canonical contexts (contextKey/cwdRel/kind/
 * fingerprint/declarationRefs/manifestInputs). A missing root fails closed.
 */
export function canonicalSmokeContexts(root) {
  const plan = planInvocationContexts(root);
  const byRel = new Map();
  for (const c of plan.contexts) {
    if (!byRel.has(c.rel)) byRel.set(c.rel, []);
    byRel.get(c.rel).push(c);
  }
  for (const list of byRel.values()) {
    list.sort((a, b) => (a.contextKey < b.contextKey ? -1 : a.contextKey > b.contextKey ? 1 : 0));
  }
  return byRel;
}

/**
 * Resolve the expected canonical smoke scope (round 30).
 *
 * The scope is ALWAYS re-derived from CURRENT source by the ONE canonical
 * discovery module — never trusted from the artifact and never taken from a
 * caller-supplied divergent copy. A caller MAY inject a `smokeScope()`
 * unit-test seam (with a synthetic root); otherwise the scope is derived from
 * `ctx.root`. A missing capability FAILS CLOSED (returns null after recording a
 * problem), so the downstream discovery/spec checks can never be skipped.
 *
 * @returns {{subjects: Array<{path:string,source:string}>, specs: string[]}|null}
 */
export function resolveExpectedSmokeScope(ctx, problems) {
  if (ctx && typeof ctx.smokeScope === 'function') {
    const s = ctx.smokeScope();
    if (s && Array.isArray(s.subjects) && Array.isArray(s.specs)) return { subjects: s.subjects, specs: s.specs };
    problems.push('expected smoke scope seam returned an invalid shape — fail closed');
    return null;
  }
  if (!ctx || !isNonEmptyStr(ctx.root)) {
    problems.push('expected smoke scope cannot be derived (no root/discovery context) — fail closed');
    return null;
  }
  try {
    const subjects = canonicalSmokeSubjects(ctx.root);
    // Round 34: the normal (no-seam) production path MUST derive the SAME canonical
    // spec set as `canonicalSmokeSpecs` (tooling + subjects + the committed selected
    // source-app tsconfig inputs). The previous inline union omitted the config inputs,
    // so a changed committed config would not invalidate old evidence on the normal
    // path even though `canonicalSmokeSpecs` included it.
    return { subjects, specs: canonicalSmokeSpecs(ctx.root) };
  } catch (err) {
    problems.push(`expected smoke scope cannot be derived from current source: ${err.message} — fail closed`);
    return null;
  }
}

const HEX64 = /^[0-9a-f]{64}$/i;
const isHex64 = (v) => typeof v === 'string' && HEX64.test(v);
const isNonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isNullish = (v) => v === null || v === undefined;

/** A path is safe if it is repo-relative, has no traversal, no drive/UNC/abs. */
export function isSafeRelPath(p) {
  if (!isNonEmptyStr(p)) return false;
  if (p.includes('\0')) return false;
  const norm = p.split('\\').join('/');
  if (norm.startsWith('/')) return false; // absolute POSIX
  if (/^[a-zA-Z]:/.test(norm)) return false; // drive letter
  if (norm.startsWith('//')) return false; // UNC
  const segs = norm.split('/');
  if (segs.includes('..')) return false; // traversal
  if (segs.includes('')) return false; // empty segment (e.g. "a//b")
  return true;
}

/** Pure predicate used both by the gate (with ctx) and by unit tests. */
export function validateSmokeEvidence(ev, ctx = {}) {
  const problems = [];
  if (!ev || typeof ev !== 'object') return ['evidence is not an object'];

  // Round 30: re-derive the canonical expected smoke scope up front so every
  // downstream discovery/spec comparison uses the canonical set (derived from
  // CURRENT source) and a missing capability fails closed instead of skipping.
  const expectedScope = resolveExpectedSmokeScope(ctx, problems);
  const expectedSubjects = expectedScope ? expectedScope.subjects : null;
  const expectedSmokeSpecs = expectedScope ? expectedScope.specs : null;
  // Re-derive the COMPLETE canonical current-source context set ONCE (producer
  // assertions are not the source of truth). A caller MAY inject a `smokeContexts()`
  // unit-test seam (with a synthetic root); otherwise it is derived from ctx.root.
  // A missing capability fails closed.
  let canonicalByRel = null;
  if (ctx && typeof ctx.smokeContexts === 'function') {
    try {
      const arr = ctx.smokeContexts();
      canonicalByRel = new Map();
      for (const c of Array.isArray(arr) ? arr : []) {
        if (!c || !isNonEmptyStr(c.rel)) continue;
        if (!canonicalByRel.has(c.rel)) canonicalByRel.set(c.rel, []);
        canonicalByRel.get(c.rel).push(c);
      }
    } catch {
      canonicalByRel = null;
    }
  } else if (ctx && typeof ctx.root === 'string' && ctx.root) {
    try {
      canonicalByRel = canonicalSmokeContexts(ctx.root);
    } catch {
      canonicalByRel = null;
    }
  }

  if (ev.schema !== SMOKE_EVIDENCE_SCHEMA) problems.push(`schema must be "${SMOKE_EVIDENCE_SCHEMA}" (got ${JSON.stringify(ev.schema)})`);
  if (ev.schemaVersion !== SMOKE_EVIDENCE_VERSION) problems.push(`schemaVersion must be ${SMOKE_EVIDENCE_VERSION} (got ${JSON.stringify(ev.schemaVersion)})`);
  if (!isNonEmptyStr(ev.generatedAt) || Number.isNaN(Date.parse(ev.generatedAt))) problems.push('generatedAt must be an ISO timestamp');

  // ---- Completeness declaration ------------------------------------------
  if (!ev.run || typeof ev.run !== 'object') problems.push('run is required (declare completeness)');
  else {
    if (ev.run.complete !== true) problems.push('run.complete must be true — a partial/unexecuted run is not accepted evidence');
    if (ev.run.partial === true) problems.push('run.partial must not be true — partial runs are rejected');
  }

  // ---- Source identity (supported algorithm + ACTUAL bytes) ----------------
  const src = ev.source;
  let sourceCommit = null;
  if (!src || typeof src !== 'object') {
    problems.push('source is required (evidence must be anchored to the measured source)');
  } else {
    if (!isNonEmptyStr(src.commitSha)) problems.push('source.commitSha is required');
    else if (ctx.commitExists && !ctx.commitExists(src.commitSha)) problems.push(`source.commitSha ${src.commitSha} is not a commit in this repository`);
    else if (ctx.isAncestorOfHead && !ctx.isAncestorOfHead(src.commitSha)) problems.push(`source.commitSha ${src.commitSha} is not an ancestor of HEAD — the smoke evidence is not from this lineage`);
    else sourceCommit = src.commitSha;
    if (!isNonEmptyStr(src.fingerprintAlgorithm)) problems.push('source.fingerprintAlgorithm is required');
    else if (!isNonEmptyStr(ctx.fingerprintAlgorithm)) problems.push('source fingerprint cannot be verified (no supported algorithm in context) — fail closed');
    else if (src.fingerprintAlgorithm !== ctx.fingerprintAlgorithm) problems.push(`source.fingerprintAlgorithm ${JSON.stringify(src.fingerprintAlgorithm)} is not the supported algorithm ${JSON.stringify(ctx.fingerprintAlgorithm)}`);
    if (!isHex64(src.fingerprint)) problems.push('source.fingerprint must be a 64-char hex digest of the measured source inputs');
    else if (typeof ctx.fingerprintAt !== 'function') problems.push('source fingerprint cannot be recomputed (no fingerprint context) — fail closed');
    else {
      const re = ctx.fingerprintAt(src.commitSha);
      if (!re || re.ok !== true) problems.push(`source fingerprint cannot be recomputed for ${src.commitSha}: ${re ? re.error : 'no result'}`);
      else if (re.fingerprint !== src.fingerprint) problems.push(`source.fingerprint ${src.fingerprint} != recomputed ${re.fingerprint} at ${src.commitSha} — the fingerprint does not match the actual measured source`);
    }
    // Review round 11: the fingerprint is over an EXPLICIT, consumer-re-derived
    // SMOKE scope (the discovery subject set + all smoke tooling), NOT a
    // producer-chosen `specs`. The artifact declares source.specs and it must
    // EQUAL the independently-derived set; a mismatch is rejected.
    if (!Array.isArray(src.specs) || src.specs.length === 0) {
      problems.push('source.specs must be a non-empty array of the measured smoke-scope inputs');
    } else {
      src.specs.forEach((p, i) => {
        if (!isSafeRelPath(p)) problems.push(`source.specs[${i}] ${JSON.stringify(p)} must be a repo-relative path inside the repository`);
      });
      if (Array.isArray(expectedSmokeSpecs)) {
        const a = [...new Set(src.specs)].sort();
        const b = [...new Set(expectedSmokeSpecs)].sort();
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          problems.push(`source.specs ${JSON.stringify(a)} != the canonical smoke scope ${JSON.stringify(b)} — the fingerprint scope must be the discovered subject set + smoke tooling`);
        }
      } else {
        problems.push('source.specs cannot be verified (canonical smoke scope unavailable) — fail closed');
      }
    }
    // Review round 12: every measured tooling input must ACTUALLY exist at the
    // recorded commit — a scope that names a nonexistent path (e.g. a tooling dir
    // absent from the recorded tree) must not silently fingerprint to nothing.
    if (Array.isArray(src.specs) && src.specs.length > 0 && isNonEmptyStr(src.commitSha)) {
      if (typeof ctx.specExistsAtCommit === 'function') {
        for (const p of [...new Set(src.specs)]) {
          if (!ctx.specExistsAtCommit(src.commitSha, p)) {
            problems.push(`source.specs ${JSON.stringify(p)} does not exist at the recorded commit ${src.commitSha} — measured tooling must be byte-bound to the recorded source`);
          }
        }
      } else {
        problems.push('source.specs cannot be verified at the recorded commit (no blob context) — fail closed');
      }
    }
  }

  // ---- Complete runtime discovery (re-derived from CURRENT source) ---------
  const discovery = ev.discovery;
  let discovered = null;
  if (!discovery || typeof discovery !== 'object' || !Array.isArray(discovery.subjects) || discovery.subjects.length === 0) {
    problems.push('discovery.subjects must be a non-empty array — the complete current runtime discovery is required');
  } else {
    discovered = new Set();
    discovery.subjects.forEach((s, i) => {
      const tag = `discovery.subjects[${i}]`;
      if (!s || typeof s !== 'object' || !isNonEmptyStr(s.path)) return problems.push(`${tag}.path is required`);
      if (!isSafeRelPath(s.path)) problems.push(`${tag}.path ${JSON.stringify(s.path)} must be a repo-relative path inside the repository`);
      if (discovered.has(s.path)) problems.push(`${tag} duplicate discovered subject ${JSON.stringify(s.path)}`);
      discovered.add(s.path);
      if (!isNonEmptyStr(s.source)) problems.push(`${tag}.source is required (where the subject was discovered)`);
    });
    if (typeof discovery.count !== 'number' || discovery.count !== discovered.size) {
      problems.push(`discovery.count ${JSON.stringify(discovery.count)} != ${discovered.size} unique discovered subject(s)`);
    }
    if (!Array.isArray(expectedSubjects)) {
      problems.push('discovery cannot be verified (canonical discovery scope unavailable) — fail closed');
    } else {
      const expected = new Set(expectedSubjects.map((s) => s.path));
      for (const p of expected) if (!discovered.has(p)) problems.push(`discovery is INCOMPLETE: current-source entrypoint ${JSON.stringify(p)} has no discovered subject`);
      for (const p of discovered) if (!expected.has(p)) problems.push(`discovery declares ${JSON.stringify(p)} which is not a current-source entrypoint`);
    }
  }

  // ---- Isolation proof (exercised via a PARSED raw self-test record) -------
  const iso = ev.isolation;
  if (!iso || typeof iso !== 'object') {
    problems.push('isolation proof is missing — safe no-network / disposable-filesystem isolation is REQUIRED');
  } else {
    if (iso.networkDenied !== true) problems.push('isolation.networkDenied must be true (network was not actually denied)');
    if (iso.hostWriteDenied !== true) problems.push('isolation.hostWriteDenied must be true (host writes were not actually denied)');
    if (!isNonEmptyStr(iso.mechanism)) problems.push('isolation.mechanism must name the physical containment (e.g. docker --network none --read-only)');
    const proof = iso.proof;
    if (!proof || typeof proof !== 'object') {
      problems.push('isolation.proof is missing (no evidence the denials were exercised)');
    } else {
      if (proof.exercised !== true) problems.push('isolation.proof.exercised must be true — the denials must have been actually exercised');
      const checkAttempts = (key, kind) => {
        const arr = proof[key];
        if (!Array.isArray(arr) || arr.length === 0) return problems.push(`isolation.proof.${key} must be a non-empty array of denied ${kind} attempt(s)`);
        arr.forEach((a, i) => {
          const tag = `isolation.proof.${key}[${i}]`;
          if (!a || typeof a !== 'object') return problems.push(`${tag} is not an object`);
          if (!isNonEmptyStr(a.subject)) problems.push(`${tag}.subject is required`);
          if (!isNonEmptyStr(a.kind)) problems.push(`${tag}.kind is required`);
          if (!isNonEmptyStr(a.target)) problems.push(`${tag}.target is required (name the denied target)`);
          if (a.denied !== true) problems.push(`${tag}.denied must be true — an attempt that was NOT caught is not proof of isolation`);
        });
      };
      checkAttempts('networkAttempts', 'network');
      checkAttempts('writeAttempts', 'host-file write');

      // The denials must come from a real, parsed self-test record — not an
      // asserted boolean. A tracked/hashed but non-JSON or non-self-test file is
      // rejected (root round 5 reproduced v3 accepting invented denials).
      const st = checkRawEvidence('isolation', 'selfTestRawPath', 'selfTestRawSha256', iso, null, ctx, problems, null, /*requireJson*/ true);
      if (st) {
        if (st.subject !== 'containment-selftest' && !isNonEmptyStr(st.subject)) problems.push('isolation.selfTestRawPath record must name its subject');
        const net = st.network;
        const wr = st.write;
        if (!net || typeof net !== 'object' || net.denied !== true || !isNonEmptyStr(net.target)) {
          problems.push('isolation self-test record must show an actual denied network attempt ({network:{target,denied:true}})');
        } else if (!proof.networkAttempts.some((a) => a.target === net.target && a.denied === true)) {
          problems.push(`isolation.proof.networkAttempts does not match the parsed self-test record target ${JSON.stringify(net.target)}`);
        }
        if (!wr || typeof wr !== 'object' || wr.denied !== true || !isNonEmptyStr(wr.target)) {
          problems.push('isolation self-test record must show an actual denied host-write attempt ({write:{target,denied:true}})');
        } else if (!proof.writeAttempts.some((a) => a.target === wr.target && a.denied === true)) {
          problems.push(`isolation.proof.writeAttempts does not match the parsed self-test record target ${JSON.stringify(wr.target)}`);
        }
      }
    }
  }

  // ---- Per-entrypoint results --------------------------------------------
  const results = ev.results;
  const resultPaths = new Set();
  if (!Array.isArray(results) || results.length === 0) {
    problems.push('results must be a non-empty array of per-entrypoint smoke results');
  } else {
    const rawLogHashes = ev.rawLogHashes && typeof ev.rawLogHashes === 'object' ? ev.rawLogHashes : {};
    // Owned-identity index shared across EVERY result/context/mode: distinct
    // obligations must own distinct run ids, container ids and RAW FILE identities
    // (stdout/stderr/trace-JSON/trace-TEXT/prestart/final). ONE global raw-path
    // category spans ALL subjects/contexts/modes AND every file role: a single raw
    // file identity cannot serve another invocation, context/mode or role. Only a
    // single obligation's own prestart↔final pair shares its run id / container id.
    const identityIndex = { runId: new Map(), containerId: new Map(), rawPath: new Map() };
    results.forEach((r, i) => {
      const tag = `results[${i}]`;
      if (!r || typeof r !== 'object') return problems.push(`${tag} is not an object`);
      if (!isNonEmptyStr(r.path)) problems.push(`${tag}.path is required`);
      else {
        if (resultPaths.has(r.path)) problems.push(`${tag} duplicate result for ${JSON.stringify(r.path)}`);
        resultPaths.add(r.path);
        if (!isSafeRelPath(r.path)) problems.push(`${tag}.path ${JSON.stringify(r.path)} must be a repo-relative path inside the repository`);
      }
      if (r.status !== 'ok') problems.push(`${tag} (${r.path}) status ${JSON.stringify(r.status)} is not "ok" — failed/partial/unexecuted cases are not accepted evidence`);

      // Source identity of the exact entrypoint, recomputed at the measured commit.
      if (!isHex64(r.sourceSha256)) problems.push(`${tag}.sourceSha256 must be the 64-char hex sha256 of the exact entrypoint source`);
      else if (!sourceCommit) problems.push(`${tag}.sourceSha256 cannot be verified (no verified source commit)`);
      else if (typeof ctx.sourceShaAt !== 'function') problems.push(`${tag}.sourceSha256 cannot be verified (no source-hash context) — fail closed`);
      else {
        const actual = ctx.sourceShaAt(r.path, sourceCommit);
        if (!actual) problems.push(`${tag}.sourceSha256 cannot be verified: ${r.path} has no source at ${sourceCommit}`);
        else if (actual !== r.sourceSha256) problems.push(`${tag}.sourceSha256 ${r.sourceSha256} != actual source ${actual} at ${sourceCommit} — the entrypoint bytes do not match`);
      }

      // Documented per-entrypoint contract (derived from current source).
      const derived = typeof ctx.contractFor === 'function' ? ctx.contractFor(r.path) : null;
      if (!derived) problems.push(`${tag} documented contract cannot be derived (no contract context) — fail closed`);
      const contract = r.contract;
      if (!contract || typeof contract !== 'object') problems.push(`${tag}.contract is required (the documented per-entrypoint CLI contract)`);
      else {
        if (!contract.noArgs || typeof contract.noArgs !== 'object') problems.push(`${tag}.contract.noArgs is required`);
        if (!contract.help || typeof contract.help !== 'object') problems.push(`${tag}.contract.help is required`);
        if (derived && contract.noArgs && isInt(contract.noArgs.exit) && contract.noArgs.exit !== derived.noArgs.exit) {
          problems.push(`${tag}.contract.noArgs.exit ${contract.noArgs.exit} != derived documented exit ${derived.noArgs.exit}`);
        }
        if (derived && contract.help && typeof contract.help.supported === 'boolean' && contract.help.supported !== derived.help.supported) {
          problems.push(`${tag}.contract.help.supported ${contract.help.supported} != derived (${derived.help.supported}) — help support must match current source`);
        }
      }
      // A documented exit is REQUIRED (CleanUp1 §6.2). A script whose current
      // source has NO documented no-args usage branch is a genuine missing-usage
      // failure — never given an invented passing exit (review rounds 4/5).
      if (derived && derived.noArgs && derived.noArgs.documented === false) {
        problems.push(`${tag} has NO documented no-args usage branch in current source — a documented exit is required (missing usage is a failure; fix it in a narrow prerequisite, do not invent an exit)`);
      }
      // Review round 7: a usage branch that PRINTS usage but names NO explicit
      // process.exit(N) leaves the documented exit AMBIGUOUS/UNKNOWN. Accepting
      // an arbitrary integer as "the documented exit" is exactly the invented-
      // contract defect, so ambiguity fails closed instead.
      if (derived && derived.noArgs && derived.noArgs.documented === true && derived.noArgs.exit === null) {
        problems.push(`${tag} documented no-args usage branch does not name an explicit process.exit(N) — the documented exit is AMBIGUOUS/UNKNOWN; a definite exit cannot be accepted as documented (fail closed)`);
      }
      if (derived && derived.help && derived.help.supported === true && derived.help.exit === null) {
        problems.push(`${tag} documented --help handler does not name an explicit process.exit(N) — the help exit is AMBIGUOUS/UNKNOWN; a definite help exit cannot be accepted as documented (fail closed)`);
      }

      const noArgs = r.noArgs;
      if (!noArgs || typeof noArgs !== 'object') {
        problems.push(`${tag}.noArgs is required (the no-arguments invocation must be recorded)`);
      } else {
        const docExit = derived ? derived.noArgs.exit : contract && contract.noArgs ? contract.noArgs.exit : null;
        if (!isInt(noArgs.exit)) problems.push(`${tag}.noArgs.exit must be an integer`);
        else if (isInt(docExit) && noArgs.exit !== docExit) problems.push(`${tag}.noArgs.exit must be the documented ${docExit} (got ${noArgs.exit})`);
        if (noArgs.usagePrinted !== true) problems.push(`${tag}.noArgs.usagePrinted must be true — silence is not usage`);
        if (noArgs.timedOut !== false) problems.push(`${tag}.noArgs.timedOut must be a DEFINITE false (unbounded/unrecorded termination is not accepted)`);
      }

      const helpSup = derived ? derived.help.supported : contract && contract.help ? contract.help.supported : null;
      const help = r.help;
      if (!help || typeof help !== 'object') {
        problems.push(`${tag}.help is required (use {supported:false} ONLY if the entrypoint genuinely has no --help)`);
      } else if (help.supported === false) {
        if (derived && derived.help.supported !== false) {
          problems.push(`${tag}.help.supported is false but the current source HAS a help/usage handler (${derived.evidence})`);
        }
      } else {
        if (help.supported !== true) problems.push(`${tag}.help.supported must be true or false`);
        const docHelpExit = derived && derived.help.supported ? derived.help.exit : contract && contract.help ? contract.help.exit : null;
        if (!isInt(help.exit)) problems.push(`${tag}.help.exit must be an integer`);
        else if (isInt(docHelpExit) && help.exit !== docHelpExit) problems.push(`${tag}.help.exit must be the documented ${docHelpExit} (got ${help.exit})`);
        if (help.usagePrinted !== true) problems.push(`${tag}.help.usagePrinted must be true`);
        if (help.timedOut !== false) problems.push(`${tag}.help.timedOut must be a DEFINITE false (unbounded/unrecorded termination is not accepted)`);
      }

      // Forbidden attempts: any recorded network/write/other attempt is a FAILURE.
      const audit = r.audit;
      if (!audit || typeof audit !== 'object') {
        problems.push(`${tag}.audit is required (raw attempt audit, even when empty)`);
      } else {
        for (const k of ['attemptedNetwork', 'attemptedWrites', 'attemptedOther']) {
          if (!Array.isArray(audit[k])) problems.push(`${tag}.audit.${k} must be an array`);
          else if (audit[k].length > 0) problems.push(`${tag}.audit.${k} records ${audit[k].length} attempted forbidden access(es) — a recorded forbidden attempt is a FAILURE`);
        }
      }

      // Native invocation binding: the result must carry its actual native run.
      const native = r.native;
      if (!native || typeof native !== 'object') {
        problems.push(`${tag}.native is required (the actual native invocation record binding this result)`);
      } else {
        if (!Array.isArray(native.argv) || native.argv.length === 0) problems.push(`${tag}.native.argv must be a non-empty argv array`);
        else {
          const last = native.argv[native.argv.length - 1];
          // A context-bound invocation ends with the EXACT absolute native subject
          // (which suffix-matches the repo-relative path); a legacy invocation ends
          // with the repo-relative path itself.
          const termOk = last === r.path || (isNonEmptyStr(last) && last.endsWith('/' + r.path));
          if (isNonEmptyStr(r.path) && !termOk) {
            problems.push(`${tag}.native.argv does not end with the entrypoint path ${JSON.stringify(r.path)} (got ${JSON.stringify(last)})`);
          }
        }
        if (!isInt(native.exit)) problems.push(`${tag}.native.exit must be a definite integer`);
        if (native.signal !== null && native.signal !== undefined) problems.push(`${tag}.native.signal must be null (a signalled process did not terminate normally)`);
        if (native.spawnError !== null && native.spawnError !== undefined) problems.push(`${tag}.native.spawnError must be null (a spawn failure is not a run)`);
      }

      // Raw log identity: repo-relative, contained, TRACKED+clean, bytes hashed.
      checkRawEvidence(tag, 'rawLogPath', 'rawLogSha256', r, rawLogHashes, ctx, problems, /*mapKey*/ r.path, /*requireJson*/ false);
      // Raw attempt-audit record: JSON, parsed, arrays must equal the summary.
      const auditRec = checkRawEvidence(tag, 'auditRawPath', 'auditRawSha256', r, null, ctx, problems, null, /*requireJson*/ true);
      if (auditRec && audit && typeof audit === 'object') {
        for (const k of ['attemptedNetwork', 'attemptedWrites', 'attemptedOther']) {
          if (!Array.isArray(auditRec[k])) problems.push(`${tag} raw audit record must contain an array ${k} — a non-audit file is not an attempted-access record`);
          else if (JSON.stringify(auditRec[k]) !== JSON.stringify(Array.isArray(audit[k]) ? audit[k] : null)) {
            problems.push(`${tag}.audit.${k} does not match the parsed raw audit record — the summary was fabricated`);
          }
        }
      }

      // Raw INVOCATION record: the actual native runs (no-args and --help), parsed.
      const invRec = checkRawEvidence(tag, 'invocationsRawPath', 'invocationsRawSha256', r, null, ctx, problems, null, /*requireJson*/ true);
      if (invRec) {
        if (!isNonEmptyStr(invRec.subject)) problems.push(`${tag} raw invocation record must name its subject`);
        else if (isNonEmptyStr(r.path) && invRec.subject !== r.path) problems.push(`${tag} raw invocation record subject ${JSON.stringify(invRec.subject)} != ${r.path}`);
        if (isHex64(r.sourceSha256) && invRec.sourceSha256 !== r.sourceSha256) {
          problems.push(`${tag} raw invocation record sourceSha256 does not match the result sourceSha256 — the record is for different bytes`);
        }
        const invs = invRec.invocations;
        if (!invs || typeof invs !== 'object') {
          problems.push(`${tag} raw invocation record must contain an invocations object (no execution was recorded)`);
        } else {
          // BOTH identities are required: the no-arguments run AND, when the
          // documented contract supports it, the --help run. A missing execution
          // is a hard failure (root round 5: unexecuted help accepted as success).
          const noArgsInv = invs.noArgs;
          requireInvocation(tag, 'noArgs', noArgsInv, r, { mustEndWith: r.path, args: [] }, problems, ctx);
          if (helpSup === true) requireInvocation(tag, 'help', invs.help, r, { mustEndWith: '--help', args: ['--help'] }, problems, ctx);
          // Cross-check the summary against the parsed native records EXACTLY,
          // in BOTH directions (review round 6, "raw-usage-vs-summary"): the
          // previous one-way tests only fired when the raw record asserted a
          // value, so a summary that claimed usage/timedOut while the raw
          // record said otherwise passed.
          if (noArgsInv && typeof noArgsInv === 'object' && noArgs && typeof noArgs === 'object') {
            if (isInt(noArgsInv.exit) && noArgs.exit !== noArgsInv.exit) problems.push(`${tag}.noArgs.exit ${noArgs.exit} != parsed raw no-args exit ${noArgsInv.exit} — inconsistent native exit`);
            if (typeof noArgsInv.timedOut === 'boolean' && noArgs.timedOut !== noArgsInv.timedOut) problems.push(`${tag}.noArgs.timedOut ${JSON.stringify(noArgs.timedOut)} != parsed raw no-args record ${JSON.stringify(noArgsInv.timedOut)}`);
            if (typeof noArgsInv.usagePrinted === 'boolean' && noArgs.usagePrinted !== noArgsInv.usagePrinted) problems.push(`${tag}.noArgs.usagePrinted ${JSON.stringify(noArgs.usagePrinted)} != parsed raw no-args record ${JSON.stringify(noArgsInv.usagePrinted)} — the summary was not derived from the raw execution`);
          }
          if (native && typeof native === 'object' && noArgsInv && typeof noArgsInv === 'object') {
            if (Array.isArray(native.argv) && Array.isArray(noArgsInv.argv) && JSON.stringify(native.argv) !== JSON.stringify(noArgsInv.argv)) {
              problems.push(`${tag}.native.argv ${JSON.stringify(native.argv)} != parsed raw no-args argv ${JSON.stringify(noArgsInv.argv)}`);
            }
            if (isInt(native.exit) && isInt(noArgsInv.exit) && native.exit !== noArgsInv.exit) {
              problems.push(`${tag}.native.exit ${native.exit} != parsed raw no-args exit ${noArgsInv.exit} — inconsistent native exit`);
            }
          }
          // Result-level audit must be the noArgs invocation's OWN audit (round 11):
          // never a cross-mode aggregate.
          if (noArgsInv && typeof noArgsInv === 'object' && noArgsInv.audit && typeof noArgsInv.audit === 'object' && audit && typeof audit === 'object') {
            for (const k of ['attemptedNetwork', 'attemptedWrites', 'attemptedOther']) {
              if (JSON.stringify(noArgsInv.audit[k] ?? null) !== JSON.stringify(Array.isArray(audit[k]) ? audit[k] : null)) {
                problems.push(`${tag}.audit.${k} does not match the noArgs invocation audit — the result audit must be the noArgs run's own audit`);
              }
            }
          }
          if (helpSup === true && invs.help && typeof invs.help === 'object' && help && typeof help === 'object' && help.supported === true) {
            if (isInt(invs.help.exit) && help.exit !== invs.help.exit) problems.push(`${tag}.help.exit ${help.exit} != parsed raw help exit ${invs.help.exit} — inconsistent native exit`);
            if (invs.help.entrypointExecuted !== true) problems.push(`${tag} parsed raw help record shows the entry point did NOT execute — unexecuted help is not evidence`);
            if (typeof invs.help.usagePrinted === 'boolean' && help.usagePrinted !== invs.help.usagePrinted) problems.push(`${tag}.help.usagePrinted ${JSON.stringify(help.usagePrinted)} != parsed raw help record ${JSON.stringify(invs.help.usagePrinted)} — the summary was not derived from the raw execution`);
            if (typeof invs.help.timedOut === 'boolean' && help.timedOut !== invs.help.timedOut) problems.push(`${tag}.help.timedOut ${JSON.stringify(help.timedOut)} != parsed raw help record ${JSON.stringify(invs.help.timedOut)}`);
          }
        }
        // v5: the COMPLETE canonical current-source context set must be declared
        // and every context's three smoke modes independently validated.
        validateResultContextSet(tag, r, ctx, invRec, canonicalByRel, problems, identityIndex);
      }
    });
  }

  // ---- Discovery/result set equivalence ----------------------------------
  if (discovered && results && Array.isArray(results)) {
    for (const s of discovered) if (!resultPaths.has(s)) problems.push(`discovery subject ${JSON.stringify(s)} has no smoke result — the required invocation set is incomplete`);
    for (const p of resultPaths) if (!discovered.has(p)) problems.push(`result ${JSON.stringify(p)} is not in the runtime discovery — unknown/undeclared entrypoint`);
  }

  // ---- Top-level raw log hash map ----------------------------------------
  if (!ev.rawLogHashes || typeof ev.rawLogHashes !== 'object' || Object.keys(ev.rawLogHashes).length === 0) {
    problems.push('rawLogHashes must record the raw smoke log hashes keyed by entrypoint path');
  } else {
    for (const [k, v] of Object.entries(ev.rawLogHashes)) {
      if (!isHex64(v)) problems.push(`rawLogHashes[${JSON.stringify(k)}] must be a 64-char hex digest`);
      if (resultPaths.size > 0 && !resultPaths.has(k)) problems.push(`rawLogHashes key ${JSON.stringify(k)} is not an entrypoint path`);
    }
    for (const p of resultPaths) if (!(p in ev.rawLogHashes)) problems.push(`rawLogHashes is missing the raw log hash for ${JSON.stringify(p)}`);
  }

  return problems;
}

/**
 * Validate one parsed native invocation record. Requires a definite integer
 * exit, no signal/spawn error, a DEFINITE `timedOut:false` and — critically —
 * `entrypointExecuted:true`. An unexecuted invocation is never evidence.
 */
export const SMOKE_TSX_LOADER_REL = 'apps/api/node_modules/tsx/dist/cli.mjs';

/** POSIX form of a host path (`C:\x` -> `/c/x`), matching isolation.mjs's `posix`. */
function posixHostPath(p) {
  let x = String(p).replace(/\\/g, '/');
  const d = /^([A-Za-z]):\//.exec(x);
  if (d) x = `/${d[1].toLowerCase()}/${x.slice(3)}`;
  return x.replace(/\/+$/, '');
}

/**
 * Independently re-derive the EXPECTED runtime plan for a subject from CURRENT source
 * via the ONE canonical `selectSourceAppTsConfig`. A `.ts` subject binds its nearest
 * committed app config; a non-TS subject binds none; an unresolvable config fails closed.
 */
export function expectedSmokeRuntimeFor(ctx, path) {
  // A non-TS subject binds no loader/config, so it needs no config selection (and no
  // root); a TS subject MUST have a repo root to re-derive its committed config.
  const isTs = /\.(ts|mts|cts)$/i.test(String(path).split('\\').join('/'));
  if (!isTs) return { ok: true, applicable: false, configRel: null, config: null, loader: null };
  if (!ctx || typeof ctx.root !== 'string' || !ctx.root) return { ok: false, reason: 'no repo root in context' };
  let sel;
  try {
    sel = selectSourceAppTsConfig(ctx.root, path);
  } catch (err) {
    return { ok: false, reason: `selection threw: ${err.message}` };
  }
  if (!sel || sel.ok !== true) return { ok: false, reason: (sel && sel.reason) || 'unresolved' };
  if (!sel.applicable) return { ok: true, applicable: false, configRel: null, config: null, loader: null };
  return { ok: true, applicable: true, configRel: sel.configRel };
}

/**
 * The CONTROLLED native topology the CALLER binds (the reviewer-approved binding
 * capability), NEVER read from an untrusted invocation's self-reported
 * `runtimeContext`. `native-bind` is the installed-checkout default; a caller may
 * explicitly bind a `frozen-volume` topology (with its read-only `/src` subject-deps
 * volume) for frozen-volume evidence. `tsRuntimeCliRel`, when present, selects the
 * EXACT allowlisted `/tsruntime/<cliRel>` loader derived from the committed
 * ts-runtime constant (never an arbitrary `/tsruntime/...` path).
 */
export function resolveControlledTopology(ctx) {
  const t = ctx && typeof ctx === 'object' ? ctx.nativeTopology : null;
  if (!t || typeof t !== 'object') return { mode: 'native-bind', tsRuntimeCliRel: null };
  const mode = t.mode === 'frozen-volume' ? 'frozen-volume' : 'native-bind';
  return { mode, tsRuntimeCliRel: isNonEmptyStr(t.tsRuntimeCliRel) ? String(t.tsRuntimeCliRel) : null };
}

/**
 * Independently derive the EXACT expected native binding for a subject at a canonical
 * context from the CONTROLLED topology + CURRENT source (never the artifact's
 * self-reported native fields): the absolute native cwd, the absolute native subject,
 * and (for TS) the exact bound config/loader. A non-TS subject binds null config/loader
 * but STILL requires the exact native subject/cwd/topology; `runtimeContext:none` is
 * NOT a licence to invent a path. Returns {ok:false, reason} when it cannot derive.
 */
export function expectedNativeBindingFor(ctx, path, canonicalCtx) {
  if (!ctx || typeof ctx.root !== 'string' || !ctx.root) return { ok: false, reason: 'no repo root in context' };
  const topo = resolveControlledTopology(ctx);
  const usingVolume = topo.mode === 'frozen-volume';
  const nativeRoot = posixHostPath(ctx.root);
  const cwdRel = canonicalCtx && canonicalCtx.cwdRel != null ? canonicalCtx.cwdRel : '.';
  const nativeCwd = nativeCwdFor(cwdRel, { mountedVolume: usingVolume, nativeRoot: ctx.root });
  const relNorm = normalizeRel(path);
  const nativeSubject = usingVolume ? `/src/${relNorm}` : `${nativeRoot}/${relNorm}`;
  const isTs = /\.(ts|mts|cts)$/i.test(relNorm);
  if (!isTs) return { ok: true, usingVolume, nativeRoot, nativeCwd, nativeSubject, isTs: false, config: null, loader: null, configRel: null };
  let sel;
  try {
    sel = selectSourceAppTsConfig(ctx.root, path);
  } catch (err) {
    return { ok: false, reason: `selection threw: ${err.message}` };
  }
  if (!sel || sel.ok !== true) return { ok: false, reason: (sel && sel.reason) || 'unresolved' };
  if (!sel.applicable || !sel.configRel) return { ok: false, reason: 'ts-config-unresolved' };
  const configRel = sel.configRel;
  const config = usingVolume ? `/src/${configRel}` : `${nativeRoot}/${configRel}`;
  const loader = usingVolume
    ? `/src/${SMOKE_TSX_LOADER_REL}`
    : topo.tsRuntimeCliRel
      ? `/tsruntime/${topo.tsRuntimeCliRel}`
      : `${nativeRoot}/${SMOKE_TSX_LOADER_REL}`;
  return { ok: true, usingVolume, nativeRoot, nativeCwd, nativeSubject, isTs: true, config, loader, configRel };
}

/**
 * Resolve the EXACT config/loader tokens a conforming invocation MUST carry for the
 * CONTROLLED topology and REFUSE any declared plan that disagrees. The topology is
 * ALWAYS taken from the caller-bound capability — never picked from the untrusted
 * `inv.runtimeContext` self-report, which must CONFIRM the bound topology. A TS
 * config-bearing trace with NO plan is fail-closed (no legacy config relaxation).
 * Non-TS must bind null/null (and still prove the exact native subject/cwd elsewhere).
 * Returns {config, loader} or null (problems recorded).
 */
function resolveExpectedPlan(ctx, exp, inv, ctxTag, problems) {
  if (!exp.ok) {
    problems.push(`${ctxTag} expected runtime config cannot be derived (${exp.reason}) — fail closed`);
    return null;
  }
  const topo = resolveControlledTopology(ctx);
  const name = inv.runtimeContext ?? null;
  if (!exp.applicable) {
    // A non-TS subject must bind NO loader/config. A missing/legacy context (`null`)
    // or the explicit `none` is tolerated ONLY with strict null/null config/loader
    // (still proven by the exec check); an unexpected loader/config is always refused.
    if ((name !== 'none' && name !== null) || (inv.runtimeConfig ?? null) !== null || (inv.tsxLoader ?? null) !== null) {
      problems.push(`${ctxTag} non-TS subject must bind NO loader/config (context=${JSON.stringify(name)} config=${JSON.stringify(inv.runtimeConfig ?? null)} loader=${JSON.stringify(inv.tsxLoader ?? null)})`);
      return null;
    }
    return { config: null, loader: null };
  }
  if (name === null) {
    problems.push(`${ctxTag} runtime plan is MISSING for a TS config-bearing trace — fail closed (no legacy config relaxation)`);
    return null;
  }
  // The declared context MUST confirm the CONTROLLED topology — a topology is never
  // picked from an untrusted self-report.
  if (name !== topo.mode) {
    problems.push(`${ctxTag} runtimeContext ${JSON.stringify(name)} != the controlled bound topology ${JSON.stringify(topo.mode)} — the topology is never taken from an untrusted invocation self-report`);
    return null;
  }
  if (inv.runtimeConfigRel !== exp.configRel) {
    problems.push(`${ctxTag} runtimeConfigRel ${JSON.stringify(inv.runtimeConfigRel ?? null)} != committed selected ${JSON.stringify(exp.configRel)}`);
    return null;
  }
  const native = posixHostPath(ctx.root);
  const isFrozen = topo.mode === 'frozen-volume';
  const config = isFrozen ? `/src/${exp.configRel}` : `${native}/${exp.configRel}`;
  // The ONLY controlled loaders are the EXACT volume loader `/src/<committed rel>`
  // (frozen-volume) and, for native-bind, either the EXACT allowlisted
  // `/tsruntime/<TS_RUNTIME_CLI_REL>` (when the ts-runtime constant is bound) or the
  // EXACT host-root-relative committed loader. A wildcard `/tsruntime/.+tsx/dist/cli.mjs`
  // would accept an arbitrary forged path (e.g. `/tsruntime/eviltsx/dist/cli.mjs`); it
  // is never trusted.
  const loaderExact = isFrozen
    ? `/src/${SMOKE_TSX_LOADER_REL}`
    : topo.tsRuntimeCliRel
      ? `/tsruntime/${topo.tsRuntimeCliRel}`
      : `${native}/${SMOKE_TSX_LOADER_REL}`;
  const loaderAlt = !isFrozen && topo.tsRuntimeCliRel ? `${native}/${SMOKE_TSX_LOADER_REL}` : null;
  const got = inv.tsxLoader ?? null;
  const loader = got === loaderExact ? loaderExact : loaderAlt && got === loaderAlt ? loaderAlt : null;
  if ((inv.runtimeConfig ?? null) !== config) { problems.push(`${ctxTag} runtimeConfig ${JSON.stringify(inv.runtimeConfig ?? null)} != ${JSON.stringify(config)}`); return null; }
  if (loader === null) {
    problems.push(`${ctxTag} tsxLoader ${JSON.stringify(got)} is not a controlled loader (expected ${JSON.stringify(loaderExact)}${loaderAlt ? ` or ${JSON.stringify(loaderAlt)}` : ''})`);
    return null;
  }
  return { config, loader };
}

function requireInvocation(tag, label, inv, r, { mustEndWith, args = [] }, problems, ctx, canonicalCtx = null, identityIndex = null) {
  const where = `${tag} raw invocation record (${label})`;
  if (!inv || typeof inv !== 'object') {
    problems.push(`${where} is required — no ${label} native invocation was recorded (missing execution must fail)`);
    return;
  }
  if (!Array.isArray(inv.argv) || inv.argv.length === 0 || !inv.argv.every((a) => typeof a === 'string' && a.length > 0)) {
    problems.push(`${where}.argv must be a non-empty string array`);
  } else {
    // BOTH identities must actually invoke the entrypoint path. A context-bound
    // invocation names the EXACT absolute native subject; a legacy invocation
    // names the repo-relative path. Either is accepted; a bogus help argv such as
    // ['node','--help'] that never named the entrypoint is rejected.
    const nativeSubj = isNonEmptyStr(inv.nativeSubject) && String(inv.nativeSubject).startsWith('/') ? inv.nativeSubject : null;
    const last = inv.argv[inv.argv.length - 1];
    if (isNonEmptyStr(r.path) && !inv.argv.includes(r.path) && !(nativeSubj && inv.argv.includes(nativeSubj))) {
      problems.push(`${where}.argv does not reference the entrypoint ${r.path} — an invocation that never passed the entrypoint did not execute it`);
    }
    if (mustEndWith) {
      const termOk = last === mustEndWith || (nativeSubj !== null && last === nativeSubj);
      if (!termOk) {
        problems.push(`${where}.argv must end with ${JSON.stringify(mustEndWith)} (got ${JSON.stringify(last)})`);
      }
    }
  }
  // Independently re-derive the runtime plan and resolve the EXACT bound tokens.
  const expRt = expectedSmokeRuntimeFor(ctx, r.path);
  const planResult = resolveExpectedPlan(ctx, expRt, inv, where, problems);
  if (!isInt(inv.exit)) problems.push(`${where}.exit must be a definite integer (a null/signal exit is not a completed run)`);
  if (!isNullish(inv.signal)) problems.push(`${where}.signal must be null (a signalled process did not terminate normally)`);
  if (!isNullish(inv.spawnError)) problems.push(`${where}.spawnError must be null (a spawn failure is not a run)`);
  if (inv.timedOut !== false) problems.push(`${where}.timedOut must be a DEFINITE false`);
  if (inv.entrypointExecuted !== true) problems.push(`${where}.entrypointExecuted must be true — an unexecuted invocation is not evidence`);
  if (typeof inv.usagePrinted !== 'boolean') problems.push(`${where}.usagePrinted must be a boolean`);

  // Actual raw stdout/stderr/trace binding (review round 6): the invocation
  // record must point at the committed, hash-verified bytes it captured. A
  // record that asserts an exit/usage with no bound raw stream — or with a
  // non-JSON "trace" — is a fabricated summary, not a native run.
  if (!ctx || typeof ctx !== 'object') {
    problems.push(`${where} cannot be bound to its raw stdout/stderr/trace (no evidence context) — fail closed`);
    return;
  }
  checkRawEvidence(where, 'stdoutRawPath', 'stdoutRawSha256', inv, null, ctx, problems, null, false);
  checkRawEvidence(where, 'stderrRawPath', 'stderrRawSha256', inv, null, ctx, problems, null, false);
  const trace = checkRawEvidence(where, 'traceRawPath', 'traceRawSha256', inv, null, ctx, problems, null, true);
  // (a) Review round 12: a per-invocation PARSED audit is MANDATORY (never optional).
  const invAudit = typeof inv.audit === 'object' && inv.audit !== null ? inv.audit : null;
  if (!invAudit) problems.push(`${where}.audit is required — a per-invocation parsed attempt audit must be recorded`);
  else for (const k of ['attemptedNetwork', 'attemptedWrites', 'attemptedOther']) if (!Array.isArray(invAudit[k])) problems.push(`${where}.audit.${k} must be an array`);
  // (b) the parsed-JSON trace arrays must agree with this invocation's OWN audit.
  if (trace) {
    for (const k of ['attemptedNetwork', 'attemptedWrites', 'attemptedOther']) {
      if (!Array.isArray(trace[k])) problems.push(`${where} parsed trace must contain an array ${k} — a non-trace file is not an attempt-audit trace`);
    }
    if (invAudit) {
      for (const k of ['attemptedNetwork', 'attemptedWrites', 'attemptedOther']) {
        if (Array.isArray(trace[k]) && JSON.stringify(trace[k]) !== JSON.stringify(Array.isArray(invAudit[k]) ? invAudit[k] : null)) {
          problems.push(`${where} parsed trace ${k} does not match this invocation's own audit — the record was not from the same run`);
        }
      }
    }
  }
  // (c) Review round 12 + v5: the ACTUAL raw syscall TEXT is bound through the
  //     ONE canonical STREAMING parser (bounded buffers — never a whole-file
  //     read/hash); it must prove the subject node exec'd against the EXACT bound
  //     absolute native subject and agree with this invocation's audit. A
  //     forged/cleaned audit (JSON claims no attempt while the raw trace shows
  //     one) fails closed. Missing/empty/altered trace fails closed.
  const parsed = bindRawTraceStream(where, 'traceTextRawPath', 'traceTextRawSha256', inv, ctx, problems);
  if (parsed) {
    if (planResult === null) {
      problems.push(`${where} raw trace cannot be proven against a bound runtime plan (expected plan missing/mismatched) — fail closed`);
    } else if (
      !entrypointExecutedFromTrace(parsed, {
        subject: r.path,
        args,
        runtimeConfig: planResult.config,
        loader: planResult.loader,
        nativeSubject: inv.nativeSubject,
      })
    ) {
      problems.push(`${where} raw trace shows no subject entrypoint execve (node ${JSON.stringify(r.path)} args ${JSON.stringify(args)}) with the exact bound runtime plan (config=${JSON.stringify(planResult.config)} loader=${JSON.stringify(planResult.loader)} nativeSubject=${JSON.stringify(inv.nativeSubject ?? null)}) — a bootstrap/loader/unrelated-node/foreign-prefix/unbound-config trace is not the executed subject`);
    }
    if (invAudit) {
      if (JSON.stringify(parsed.network) !== JSON.stringify(Array.isArray(invAudit.attemptedNetwork) ? invAudit.attemptedNetwork : null)) {
        problems.push(`${where} raw trace network attempts do not match the invocation audit — a forged/cleaned audit`);
      }
      if (JSON.stringify(parsed.write) !== JSON.stringify(Array.isArray(invAudit.attemptedWrites) ? invAudit.attemptedWrites : null)) {
        problems.push(`${where} raw trace forbidden writes do not match the invocation audit — a forged/cleaned audit`);
      }
    }
    if (trace && Array.isArray(trace.attemptedNetwork) && JSON.stringify(parsed.network) !== JSON.stringify(trace.attemptedNetwork)) {
      problems.push(`${where} raw trace network attempts do not match the parsed trace JSON`);
    }
    if (trace && Array.isArray(trace.attemptedWrites) && JSON.stringify(parsed.write) !== JSON.stringify(trace.attemptedWrites)) {
      problems.push(`${where} raw trace forbidden writes do not match the parsed trace JSON`);
    }
  }
  // v5 context binding: the invocation must carry the EXACT canonical context key
  // and declared cwd, and its lifecycle MUST be backed by the parsed, hash-bound
  // prestart + final receipts (identity/order/ownership/completeness + lossless
  // WorkingDir / real returned run CID).
  if (canonicalCtx) validateContextInvocationBinding(where, inv, r, args, canonicalCtx, ctx, problems, identityIndex);
}

/**
 * Claim a single owned-identity value for one (subject, context, mode) obligation.
 * Different obligations MUST own DISTINCT run ids, container ids, prestart/final
 * receipt paths and trace paths. Only a single obligation's own prestart↔final pair
 * shares its run id / container id. Reusable even when bytes/metadata are rehashed.
 */
function claimIdentity(index, kind, value, key, label, problems) {
  if (!index || !isNonEmptyStr(value)) return;
  const cur = index[kind].get(value);
  if (cur === undefined) index[kind].set(value, key);
  else if (cur !== key) {
    problems.push(`${label} reuses the ${kind} ${JSON.stringify(value)} already owned by ${JSON.stringify(cur)} — distinct contexts/modes must have distinct owned ${kind}s`);
  }
}

/** The SIX per-invocation raw file roles that participate in the ONE global
 *  raw-path identity category. A single raw file identity cannot serve another
 *  invocation/context/mode OR another role (stdout vs trace vs prestart …). */
const RAW_PATH_ROLES = [
  ['stdout', 'stdoutRawPath'],
  ['stderr', 'stderrRawPath'],
  ['traceJson', 'traceRawPath'],
  ['traceText', 'traceTextRawPath'],
  ['prestart', 'prestartRawPath'],
  ['final', 'finalRawPath'],
];

/** Normalise a raw path to its canonical identity: POSIX separators, no leading
 *  `./`, and — when the caller supplies a `realpath` seam — the ACTUAL contained
 *  realpath, so two aliases of the SAME physical file collide instead of slipping
 *  through under different spellings. */
function normalizeRawIdentity(rel, ctx) {
  let p = String(rel).split('\\').join('/').replace(/^\.\//, '');
  if (ctx && typeof ctx.realpath === 'function') {
    try {
      const r = ctx.realpath(rel);
      if (isNonEmptyStr(r)) p = String(r).split('\\').join('/').replace(/^\.\//, '');
    } catch {
      /* keep the normalised spelling */
    }
  }
  return p;
}

/** Claim ONE raw file identity for one (subject, context, mode, role) obligation.
 *  Reuse by a DIFFERENT obligation OR a different role is refused. The SAME
 *  obligation rechecked (summary anchor vs context validation) resolves to the
 *  identical identity and is never a false collision. Distinct pre↔final of one
 *  invocation are separate roles and so remain distinct raw files. */
function claimRawIdentity(index, role, rel, ownKey, label, problems, ctx) {
  if (!index || !isNonEmptyStr(rel)) return;
  const norm = normalizeRawIdentity(rel, ctx);
  const here = `${ownKey}#${role}`;
  const prev = index.rawPath.get(norm);
  if (prev === undefined) index.rawPath.set(norm, here);
  else if (prev !== here) {
    problems.push(`${label} raw ${role} path ${JSON.stringify(rel)} reuses an owned raw file identity (already held by ${JSON.stringify(prev)}) — one raw file identity cannot serve another invocation, context/mode or file role`);
  }
}

/**
 * Bind a lifecycle receipt's COMPLETE `invocationContext` to the freshly derived
 * canonical context. Changing the embedded context while leaving the scalar
 * receipt fields consistent is REFUSED: the receipt must carry the actual full
 * canonical provenance (rel/cwd/kind/fingerprint/declaration refs/declarations/
 * controlling manifest-input hashes), not merely a matching contextKey.
 */
function contextProvenanceProblems(label, actual, canonicalCtx, problems) {
  if (!actual || typeof actual !== 'object') {
    problems.push(`${label} must carry the complete canonical invocationContext (got ${JSON.stringify(actual ?? null)})`);
    return;
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  if (actual.contextKey !== canonicalCtx.contextKey) problems.push(`${label} invocationContext.contextKey ${JSON.stringify(actual.contextKey ?? null)} != canonical ${JSON.stringify(canonicalCtx.contextKey)}`);
  if (actual.rel !== canonicalCtx.rel) problems.push(`${label} invocationContext.rel ${JSON.stringify(actual.rel ?? null)} != canonical ${JSON.stringify(canonicalCtx.rel)}`);
  if (actual.cwdRel !== canonicalCtx.cwdRel) problems.push(`${label} invocationContext.cwdRel ${JSON.stringify(actual.cwdRel ?? null)} != canonical ${JSON.stringify(canonicalCtx.cwdRel)}`);
  if (actual.kind !== canonicalCtx.kind) problems.push(`${label} invocationContext.kind ${JSON.stringify(actual.kind ?? null)} != canonical ${JSON.stringify(canonicalCtx.kind)}`);
  if (actual.fingerprint !== canonicalCtx.fingerprint) problems.push(`${label} invocationContext.fingerprint does not match the canonical current-source provenance — a forged/stale context`);
  const aRefs = (Array.isArray(actual.declarationRefs) ? actual.declarationRefs : []).map(String).slice().sort(cmp);
  if (JSON.stringify(aRefs) !== JSON.stringify((Array.isArray(canonicalCtx.declarationRefs) ? canonicalCtx.declarationRefs : []).slice().sort(cmp))) {
    problems.push(`${label} invocationContext declaration reference set does not match the canonical context`);
  }
  const normDecl = (v) => JSON.stringify(Array.isArray(v) ? v : []);
  if (normDecl(actual.declarations) !== normDecl(canonicalCtx.declarations)) problems.push(`${label} invocationContext declarations do not match the canonical current-source context`);
  const aMan = (Array.isArray(actual.manifestInputs) ? actual.manifestInputs : [])
    .map((m) => ({ rel: (m && m.rel) ?? null, sha256: (m && m.sha256) ?? null }))
    .sort((x, y) => cmp(String(x.rel), String(y.rel)));
  const cMan = (Array.isArray(canonicalCtx.manifestInputs) ? canonicalCtx.manifestInputs : []).map((m) => ({ rel: m.rel, sha256: m.sha256 }));
  if (JSON.stringify(aMan) !== JSON.stringify(cMan)) problems.push(`${label} invocationContext controlling manifest-input hashes do not match the canonical context`);
  if (actual.valid === false) problems.push(`${label} invocationContext must be a valid canonical context (got invalid)`);
}

/**
 * v5 independent context-invocation verification. Re-derives, from the PARSED
 * raw records + the CONTROLLED caller-bound topology ONLY (never a Boolean
 * `verified` flag and never the artifact's self-reported native fields), that: the
 * invocation binds this canonical context key + declared cwd; the EXACT absolute
 * native subject/cwd (and, for TS, config/loader) DERIVE from CURRENT source; the
 * actual container WorkingDir proof is lossless and matches the derived native cwd;
 * and BOTH the prestart and final lifecycle receipts exist, are hash-bound, parse,
 * AGREE with each other and this invocation (immutable created-at/mode/owner/source/
 * runtime/working-dir, exact returned 64-hex container CID, subject, mode args,
 * context key), carry a finite exit / explicit-null signal+error / no transport
 * error, and prove actual removal/termination. Each obligation's owned run
 * id/container id/receipt/trace identities must be distinct across contexts/modes.
 */
function validateContextInvocationBinding(where, inv, r, args, canonicalCtx, ctx, problems, identityIndex = null) {
  if (inv.contextKey !== canonicalCtx.contextKey) {
    problems.push(`${where}.contextKey ${JSON.stringify(inv.contextKey)} != canonical ${JSON.stringify(canonicalCtx.contextKey)} — a wrong-subject/wrong-cwd context`);
  }
  if (inv.cwdRel !== canonicalCtx.cwdRel) {
    problems.push(`${where}.cwdRel ${JSON.stringify(inv.cwdRel)} != canonical ${JSON.stringify(canonicalCtx.cwdRel)}`);
  }
  // Independently DERIVE the expected absolute native subject/cwd (+ TS config/loader)
  // from CURRENT source + the controlled caller-bound topology. The artifact's
  // self-reported native fields are never the source of truth.
  const binding = expectedNativeBindingFor(ctx, r.path, canonicalCtx);
  if (!binding.ok) {
    problems.push(`${where} expected native binding cannot be derived (${binding.reason}) — fail closed`);
  }
  const derivedNativeCwd = binding.ok ? binding.nativeCwd : null;
  const derivedNativeSubject = binding.ok ? binding.nativeSubject : null;
  if (binding.ok) {
    if (inv.nativeSubject !== derivedNativeSubject) {
      problems.push(`${where}.nativeSubject ${JSON.stringify(inv.nativeSubject ?? null)} != the independently derived native subject ${JSON.stringify(derivedNativeSubject)} — a foreign-prefix/forged subject`);
    }
    if (inv.nativeCwd !== derivedNativeCwd) {
      problems.push(`${where}.nativeCwd ${JSON.stringify(inv.nativeCwd ?? null)} != the independently derived native cwd ${JSON.stringify(derivedNativeCwd)} — a forged cwd`);
    }
    if ((inv.runtimeConfig ?? null) !== binding.config) problems.push(`${where}.runtimeConfig ${JSON.stringify(inv.runtimeConfig ?? null)} != the derived ${JSON.stringify(binding.config)}`);
    if ((inv.runtimeConfigRel ?? null) !== binding.configRel) problems.push(`${where}.runtimeConfigRel ${JSON.stringify(inv.runtimeConfigRel ?? null)} != the derived ${JSON.stringify(binding.configRel)}`);
    if ((inv.tsxLoader ?? null) !== binding.loader) problems.push(`${where}.tsxLoader ${JSON.stringify(inv.tsxLoader ?? null)} != the derived ${JSON.stringify(binding.loader)}`);
  }
  // Actual WorkingDir proof: absolute native subject + lossless inspected cwd.
  const wd = inv.workingDirInspect;
  if (typeof inv.nativeSubject !== 'string' || !inv.nativeSubject.startsWith('/')) {
    problems.push(`${where}.nativeSubject must be the EXACT absolute native subject for a context-bound invocation (got ${JSON.stringify(inv.nativeSubject ?? null)})`);
  }
  if (typeof inv.nativeCwd !== 'string' || !inv.nativeCwd) {
    problems.push(`${where}.nativeCwd must be the actual expected absolute native cwd`);
  }
  if (!wd || typeof wd !== 'object') {
    problems.push(`${where}.workingDirInspect is required (the actual inspected container WorkingDir proof)`);
  } else {
    const cid = inv.containerId;
    if (typeof cid !== 'string' || !isHex64(cid)) {
      problems.push(`${where}.containerId must be the REAL returned 64-hex container id (no missing-returned-CID fallback)`);
    }
    if (wd.verified !== true) problems.push(`${where}.workingDirInspect.verified must be true`);
    if (wd.expected !== derivedNativeCwd || wd.parsed !== derivedNativeCwd) problems.push(`${where}.workingDirInspect expected/parsed must equal the independently derived native cwd ${JSON.stringify(derivedNativeCwd)}`);
    // `raw` is the producer's EXACT `stdoutRaw.trim()` (isolation.mjs: `wdRaw = wdStdout.trim()`).
    // A real `docker inspect --format {{json .Config.WorkingDir}}` returns the JSON
    // STRING LITERAL — quotes included, e.g. `"/src"` — so `raw` is NOT the decoded
    // path. Bind `raw` byte-for-byte to the retained stdout bytes (trimmed); the
    // decoded cwd is proven INDEPENDENTLY from `stdoutRaw` below (JSON.parse). An
    // arbitrary `raw` string is never accepted merely because `parsed` looks right.
    if (typeof wd.stdoutRaw !== 'string' || wd.raw !== wd.stdoutRaw.trim()) {
      problems.push(`${where}.workingDirInspect.raw must be the EXACT retained stdoutRaw.trim() (the producer's raw inspect text), got ${JSON.stringify(wd.raw ?? null)}`);
    }
    if (wd.inspectExit !== 0) problems.push(`${where}.workingDirInspect.inspectExit must be a definite 0`);
    // Explicit null, NOT undefined: the producer always emits inspectSignal/inspectError;
    // an omitted field is a forged/trimmed receipt, not an honest transport success.
    if (wd.inspectSignal !== null) problems.push(`${where}.workingDirInspect.inspectSignal must be an EXPLICIT null (got ${JSON.stringify(wd.inspectSignal)})`);
    if (wd.inspectError !== null) problems.push(`${where}.workingDirInspect.inspectError must be an EXPLICIT null (got ${JSON.stringify(wd.inspectError)})`);
    if (wd.contextKey !== canonicalCtx.contextKey) problems.push(`${where}.workingDirInspect.contextKey must equal the canonical context key`);
    if (typeof cid === 'string' && isHex64(cid) && wd.exactContainerId !== cid) {
      problems.push(`${where}.workingDirInspect.exactContainerId ${JSON.stringify(wd.exactContainerId)} != the returned container id ${JSON.stringify(cid)}`);
    }
    // Lossless inspection bytes, independently re-hashed/counted.
    if (typeof wd.stdoutRaw !== 'string' || !isHex64(wd.stdoutSha256) || wd.stdoutSha256 !== sha256Utf8(wd.stdoutRaw) || !Number.isInteger(wd.stdoutBytes) || wd.stdoutBytes !== utf8ByteLength(wd.stdoutRaw)) {
      problems.push(`${where}.workingDirInspect lossless stdout sha256/byte-count do not match the retained raw bytes`);
    }
    if (typeof wd.stderrRaw !== 'string' || !isHex64(wd.stderrSha256) || wd.stderrSha256 !== sha256Utf8(wd.stderrRaw) || !Number.isInteger(wd.stderrBytes) || wd.stderrBytes !== utf8ByteLength(wd.stderrRaw)) {
      problems.push(`${where}.workingDirInspect lossless stderr sha256/byte-count do not match the retained raw bytes`);
    }
    // Independently parse the JSON WorkingDir from the retained stdout bytes.
    let wdParsed = null;
    try {
      const v = JSON.parse(String(wd.stdoutRaw ?? '').trim());
      if (typeof v === 'string') wdParsed = v;
    } catch {
      /* malformed */
    }
    if (wdParsed !== derivedNativeCwd) problems.push(`${where}.workingDirInspect.stdoutRaw does not parse to the derived native cwd — WorkingDir proof is not independently reproducible`);
  }
  // Lifecycle receipts: BOTH required, parsed, hash-bound, agreeing.
  const pre = checkRawEvidence(where, 'prestartRawPath', 'prestartRawSha256', inv, null, ctx, problems, null, /*requireJson*/ true);
  const fin = checkRawEvidence(where, 'finalRawPath', 'finalRawSha256', inv, null, ctx, problems, null, /*requireJson*/ true);
  if (!pre) problems.push(`${where} prestart lifecycle receipt was not recorded`);
  if (!fin) problems.push(`${where} final lifecycle receipt was not recorded`);
  const modeLabel = args.length === 0 ? 'noArgs' : args[0] === '--help' ? 'help' : 'unknown';
  const ownKey = `${r.path}|${canonicalCtx.contextKey}|${modeLabel}`;
  if (pre) {
    // Owned-identity claims: distinct across contexts/modes (own pre↔final pair shares).
    claimIdentity(identityIndex, 'runId', pre.runId, ownKey, `${where} prestart receipt`, problems);
    claimIdentity(identityIndex, 'containerId', pre.containerId, ownKey, `${where} prestart receipt`, problems);
  }
  if (fin) {
    claimIdentity(identityIndex, 'runId', fin.runId, ownKey, `${where} final receipt`, problems);
    claimIdentity(identityIndex, 'containerId', fin.containerId, ownKey, `${where} final receipt`, problems);
  }
  // ONE global raw-path category: every per-invocation raw file role (stdout,
  // stderr, trace-JSON, trace-TEXT, prestart, final) is claimed. A path reused by
  // another invocation/context/mode OR for another role is refused; the same
  // invocation rechecked resolves to the same identity and never falsely collides.
  for (const [role, pathKey] of RAW_PATH_ROLES) {
    claimRawIdentity(identityIndex, role, inv[pathKey], ownKey, where, problems, ctx);
  }
  if (pre && fin) {
    if (!isNonEmptyStr(pre.runId) || pre.runId !== fin.runId) problems.push(`${where} lifecycle receipt runIds must match exactly`);
    if (pre.containerId !== fin.containerId) problems.push(`${where} lifecycle receipt containerIds must match exactly`);
    if (typeof inv.containerId === 'string' && isHex64(inv.containerId) && pre.containerId !== inv.containerId) {
      problems.push(`${where} lifecycle receipt containerId ${JSON.stringify(pre.containerId)} != the returned container id ${JSON.stringify(inv.containerId)}`);
    }
    if (pre.subject !== r.path || fin.subject !== r.path) problems.push(`${where} lifecycle receipt subject must equal the entrypoint ${JSON.stringify(r.path)}`);
    if (pre.contextKey !== canonicalCtx.contextKey || fin.contextKey !== canonicalCtx.contextKey) problems.push(`${where} lifecycle receipt contextKey must equal the canonical context key`);
    // Exact smoke mode args on BOTH receipts (never only the prestart).
    if (JSON.stringify(pre.modeArgs ?? null) !== JSON.stringify(args)) problems.push(`${where} prestart lifecycle receipt modeArgs ${JSON.stringify(pre.modeArgs ?? null)} != the exact smoke mode args ${JSON.stringify(args)}`);
    if (JSON.stringify(fin.modeArgs ?? null) !== JSON.stringify(args)) problems.push(`${where} final lifecycle receipt modeArgs ${JSON.stringify(fin.modeArgs ?? null)} != the exact smoke mode args ${JSON.stringify(args)}`);
    // The ACTUAL producer lifecycle shape (isolation.mjs finalRec): the prestart
    // fields spread, then startExit/waitExit/logsExit/startFailed/logsUnavailable/
    // waitUnavailable/waitDeadline/containerExit/timedOut/removal/finishedAt. There
    // is NO `started` boolean — do not invent one as the only real start proof.
    if (fin.startExit !== 0) problems.push(`${where} final lifecycle receipt must prove a successful real start (startExit=${JSON.stringify(fin.startExit)})`);
    if (fin.startFailed === true) problems.push(`${where} final lifecycle receipt records a failed start`);
    if (fin.waitExit !== 0) problems.push(`${where} final lifecycle receipt must prove a successful wait transport (waitExit=${JSON.stringify(fin.waitExit)})`);
    if (fin.waitUnavailable === true) problems.push(`${where} final lifecycle receipt records an unavailable wait`);
    if (fin.waitDeadline === true) problems.push(`${where} final lifecycle receipt records a wait deadline`);
    if (fin.logsExit !== 0) problems.push(`${where} final lifecycle receipt must prove a successful logs transport (logsExit=${JSON.stringify(fin.logsExit)})`);
    if (fin.logsUnavailable === true) problems.push(`${where} final lifecycle receipt records unavailable logs`);
    if (fin.createFailed === true || fin.setupError === true || fin.unknown === true || fin.workingDirFailed === true) problems.push(`${where} final lifecycle receipt records a setup/create/unknown failure`);
    if (fin.timedOut === true) problems.push(`${where} final lifecycle receipt records a timeout`);
    // The producer ALWAYS emits these transport/failure flags; an accepted (ok) run
    // must show them as an EXPLICIT false — absence is not an honest success.
    if (pre.schemaVersion !== 1 || fin.schemaVersion !== 1) problems.push(`${where} lifecycle receipts must carry schemaVersion 1`);
    for (const k of ['startFailed', 'logsUnavailable', 'waitUnavailable', 'waitDeadline', 'timedOut']) {
      if (fin[k] !== false) problems.push(`${where} final lifecycle receipt ${k} must be an EXPLICIT false (got ${JSON.stringify(fin[k])})`);
    }
    if (!Number.isInteger(fin.containerExit)) problems.push(`${where} final lifecycle receipt containerExit must be a definite finite integer`);
    else if (Number.isInteger(inv.exit) && fin.containerExit !== inv.exit) problems.push(`${where} final lifecycle receipt containerExit ${fin.containerExit} != this invocation's exit ${inv.exit}`);
    if (!fin.removal || typeof fin.removal !== 'object') problems.push(`${where} final lifecycle receipt must carry a removal proof`);
    else {
      if (fin.removal.removed !== true) problems.push(`${where} final lifecycle receipt must prove the owned container was actually removed (${JSON.stringify(fin.removal.detail ?? fin.removal)})`);
      // Explicit removal.unknown===false is REQUIRED: an omitted/undefined `unknown`
      // is a trimmed proof, not an honest successful removal.
      if (fin.removal.unknown !== false) problems.push(`${where} final lifecycle receipt removal.unknown must be an EXPLICIT false (got ${JSON.stringify(fin.removal.unknown)})`);
    }
    // Order + real ISO timestamps. `Date.parse` alone accepts many loose formats,
    // so the ACTUAL ISO-8601 UTC shape is required; the lifecycle must never run
    // backwards (prestart <= final).
    const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
    const preMs = Date.parse(pre.createdAt);
    const finCreateMs = Date.parse(fin.createdAt);
    const finMs = Date.parse(fin.finishedAt);
    if (!ISO_UTC.test(String(pre.createdAt ?? '')) || Number.isNaN(preMs)) problems.push(`${where} prestart lifecycle receipt createdAt must be an actual ISO-8601 UTC timestamp`);
    if (!ISO_UTC.test(String(fin.createdAt ?? '')) || Number.isNaN(finCreateMs)) problems.push(`${where} final lifecycle receipt createdAt must be an actual ISO-8601 UTC timestamp`);
    if (!ISO_UTC.test(String(fin.finishedAt ?? '')) || Number.isNaN(finMs)) problems.push(`${where} final lifecycle receipt finishedAt must be an actual ISO-8601 UTC timestamp`);
    if (!Number.isNaN(preMs) && !Number.isNaN(finMs) && preMs > finMs) problems.push(`${where} prestart receipt time ${pre.createdAt} is after final ${fin.finishedAt} — invalid lifecycle order`);
    // The final receipt SPREADS the immutable prestart fields: every one must be
    // byte-identical. A mutated final createdAt/mode/owner/source/runtime/WD is refused.
    const IMMUTABLE = [
      'schemaVersion', 'runId', 'containerName', 'containerId', 'label', 'subject', 'modeArgs',
      'image', 'evidenceDir', 'contextKey', 'nativeCwd', 'nativeSubject', 'createdAt',
      'runtimeConfig', 'runtimeConfigRel', 'tsxLoader',
    ];
    for (const k of IMMUTABLE) {
      if (JSON.stringify(pre[k] ?? null) !== JSON.stringify(fin[k] ?? null)) {
        problems.push(`${where} final lifecycle receipt ${k} ${JSON.stringify(fin[k] ?? null)} differs from the immutable prestart value ${JSON.stringify(pre[k] ?? null)}`);
      }
    }
    if (JSON.stringify(pre.ownership ?? null) !== JSON.stringify(fin.ownership ?? null)) problems.push(`${where} final lifecycle receipt ownership differs from the immutable prestart ownership`);
    if (JSON.stringify(pre.source ?? null) !== JSON.stringify(fin.source ?? null)) problems.push(`${where} final lifecycle receipt source differs from the immutable prestart source`);
    if (JSON.stringify(pre.workingDirInspect ?? null) !== JSON.stringify(fin.workingDirInspect ?? null)) problems.push(`${where} final lifecycle receipt workingDirInspect differs from the immutable prestart inspection`);
    // ACTUAL owner identity: the exact `cleanup-smoke.run=<runId>` label + the exact
    // `${containerId}|${runId}` ownership proof, on BOTH receipts.
    for (const [which, rec] of [['prestart', pre], ['final', fin]]) {
      // Producer-required identity facts that MUST be present on BOTH receipts —
      // never omitted on both (which the pre↔final immutability compare alone would
      // not catch). The producer always records these on every lifecycle path.
      if (!isNonEmptyStr(rec.image)) problems.push(`${where} ${which} lifecycle receipt image is required (the producer records the isolated image identity on every receipt)`);
      if (!isNonEmptyStr(rec.evidenceDir)) problems.push(`${where} ${which} lifecycle receipt evidenceDir is required (the producer records the owned evidence dir on every receipt)`);
      for (const k of ['runtimeConfig', 'runtimeConfigRel', 'tsxLoader']) {
        if (!(k in rec)) problems.push(`${where} ${which} lifecycle receipt ${k} must be PRESENT (an explicit null for a non-TS subject), not omitted`);
      }
      if (rec.label !== `cleanup-smoke.run=${rec.runId}`) problems.push(`${where} ${which} lifecycle receipt label ${JSON.stringify(rec.label)} != the owned run label cleanup-smoke.run=${JSON.stringify(rec.runId)}`);
      const own = rec.ownership;
      if (!own || typeof own !== 'object' || own.verified !== true || own.inspectExit !== 0 || own.raw !== `${rec.containerId}|${rec.runId}`) {
        problems.push(`${where} ${which} lifecycle receipt must carry the ACTUAL ownership proof ({verified:true, inspectExit:0, raw:"<cid>|<runId>"}) — got ${JSON.stringify(own ?? null)}`);
      }
      // Source identity: the exact entrypoint path + its measured sha256.
      if (!rec.source || typeof rec.source !== 'object' || rec.source.path !== r.path) {
        problems.push(`${where} ${which} lifecycle receipt source.path must be the entrypoint ${JSON.stringify(r.path)} — got ${JSON.stringify(rec.source ?? null)}`);
      } else if (isHex64(r.sourceSha256) && rec.source.sha256 !== r.sourceSha256) {
        problems.push(`${where} ${which} lifecycle receipt source.sha256 ${JSON.stringify(rec.source.sha256)} != the measured entrypoint source ${JSON.stringify(r.sourceSha256)}`);
      }
      // Exact bound runtime plan on the receipt too.
      if ((rec.runtimeConfig ?? null) !== (binding.ok ? binding.config : (inv.runtimeConfig ?? null))) problems.push(`${where} ${which} lifecycle receipt runtimeConfig ${JSON.stringify(rec.runtimeConfig ?? null)} != the bound plan ${JSON.stringify(binding.ok ? binding.config : (inv.runtimeConfig ?? null))}`);
      if ((rec.runtimeConfigRel ?? null) !== (binding.ok ? binding.configRel : (inv.runtimeConfigRel ?? null))) problems.push(`${where} ${which} lifecycle receipt runtimeConfigRel ${JSON.stringify(rec.runtimeConfigRel ?? null)} != the bound plan rel`);
      if ((rec.tsxLoader ?? null) !== (binding.ok ? binding.loader : (inv.tsxLoader ?? null))) problems.push(`${where} ${which} lifecycle receipt tsxLoader ${JSON.stringify(rec.tsxLoader ?? null)} != the bound plan loader`);
    }
    // Full source/runtime/context/mode/subject binding on BOTH receipts (never only
    // the final), so the two same-owned-run receipts are cross-bound end to end.
    if (pre.nativeCwd !== derivedNativeCwd || fin.nativeCwd !== derivedNativeCwd) problems.push(`${where} lifecycle receipt nativeCwd must equal the derived native cwd ${JSON.stringify(derivedNativeCwd)}`);
    if (pre.nativeSubject !== derivedNativeSubject || fin.nativeSubject !== derivedNativeSubject) problems.push(`${where} lifecycle receipt nativeSubject must equal the derived native subject ${JSON.stringify(derivedNativeSubject)}`);
    if (pre.contextKey !== fin.contextKey) problems.push(`${where} lifecycle receipt contextKeys must match exactly`);
    if (!Number.isNaN(finCreateMs) && !Number.isNaN(preMs) && finCreateMs !== preMs) problems.push(`${where} final lifecycle receipt createdAt must equal the immutable prestart createdAt`);
    // The COMPLETE canonical invocationContext must be carried by BOTH receipts and
    // bound to the freshly derived canonical context: changing the embedded context
    // while keeping the scalar receipt fields consistent is REFUSED.
    if (JSON.stringify(pre.invocationContext ?? null) !== JSON.stringify(fin.invocationContext ?? null)) problems.push(`${where} final lifecycle receipt invocationContext differs from the immutable prestart invocationContext`);
    contextProvenanceProblems(`${where} prestart lifecycle receipt`, pre.invocationContext, canonicalCtx, problems);
    contextProvenanceProblems(`${where} final lifecycle receipt`, fin.invocationContext, canonicalCtx, problems);
  }
}

const utf8ByteLength = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');
const sha256Utf8 = (s) => createHash('sha256').update(Buffer.from(String(s ?? ''), 'utf8')).digest('hex');

/**
 * v5 independent CONTEXT-SET verification for one result. The verifier re-derives
 * the COMPLETE canonical current-source context set for this subject (producer
 * assertions are not the source of truth) and requires the result's declared
 * context set AND the raw invocation record's context set to be EXACTLY that set:
 * no missing / extra / duplicate / wrong-subject / wrong-cwd / partial-reference /
 * stale-manifest context is accepted. Every canonical context's three smoke modes
 * are validated against the context-bound invocation proof.
 */
function validateResultContextSet(tag, r, ctx, invRec, canonicalByRel, problems, identityIndex = null) {
  if (!canonicalByRel) {
    problems.push(`${tag} canonical context set cannot be derived (no root/discovery context) — fail closed`);
    return;
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const canonical = (canonicalByRel.get(r.path) ?? []).slice().sort((a, b) => cmp(a.contextKey, b.contextKey));
  const declared = Array.isArray(r.contexts) ? r.contexts : null;
  if (!declared) {
    problems.push(`${tag}.contexts is required — schema v5 requires the complete canonical context set (no context-free evidence)`);
    return;
  }
  const canonKeys = canonical.map((c) => c.contextKey).sort(cmp);
  const declKeys = declared.map((c) => (c && c.contextKey)).sort(cmp);
  if (JSON.stringify(canonKeys) !== JSON.stringify(declKeys)) {
    problems.push(`${tag}.contexts ${JSON.stringify(declKeys)} != the canonical current-source context set ${JSON.stringify(canonKeys)} — missing/extra/stale contexts are refused`);
  }
  const declByKey = new Map(declared.map((c) => [c && c.contextKey, c]));
  const recCtxs = Array.isArray(invRec.contexts) ? invRec.contexts : null;
  if (!recCtxs) {
    problems.push(`${tag} raw invocation record must carry the complete context set (contexts[])`);
    return;
  }
  if (recCtxs.length !== new Set(recCtxs.map((c) => c && c.contextKey)).size) {
    problems.push(`${tag} raw invocation record has duplicate context keys — a context may be declared at most once`);
  }
  const recByKey = new Map(recCtxs.map((c) => [c && c.contextKey, c]));
  for (const c of canonical) {
    const rec = recByKey.get(c.contextKey);
    const ctag = `${tag} context ${JSON.stringify(c.contextKey)}`;
    // The SUMMARY context projection the result declares must ALSO match the fresh
    // canonical context in EVERY emitted field (rel/cwd/kind/fingerprint/complete
    // refs/manifests) — not merely its contextKey. A forged summary fingerprint,
    // declaration-ref set, manifest-input list or cwd is refused here.
    const summary = declByKey.get(c.contextKey);
    if (summary) {
      if (summary.rel !== c.rel) problems.push(`${ctag} summary .rel ${JSON.stringify(summary.rel ?? null)} != canonical ${JSON.stringify(c.rel)}`);
      if (summary.cwdRel !== c.cwdRel) problems.push(`${ctag} summary .cwdRel ${JSON.stringify(summary.cwdRel ?? null)} != canonical ${JSON.stringify(c.cwdRel)}`);
      if (summary.kind !== c.kind) problems.push(`${ctag} summary .kind ${JSON.stringify(summary.kind ?? null)} != canonical ${JSON.stringify(c.kind)}`);
      if (summary.fingerprint !== c.fingerprint) problems.push(`${ctag} summary .fingerprint does not match the canonical current-source provenance — a forged/stale summary context`);
      const sRefs = (Array.isArray(summary.declarationRefs) ? summary.declarationRefs : []).map(String).sort(cmp);
      if (JSON.stringify(sRefs) !== JSON.stringify(c.declarationRefs.slice().sort(cmp))) {
        problems.push(`${ctag} summary declaration reference set does not match the canonical context — a forged summary`);
      }
      const sMan = (Array.isArray(summary.manifestInputs) ? summary.manifestInputs : [])
        .map((m) => ({ rel: (m && m.rel) ?? null, sha256: (m && m.sha256) ?? null }))
        .sort((x, y) => cmp(String(x.rel), String(y.rel)));
      const cManS = c.manifestInputs.map((m) => ({ rel: m.rel, sha256: m.sha256 }));
      if (JSON.stringify(sMan) !== JSON.stringify(cManS)) {
        problems.push(`${ctag} summary controlling manifest-input hashes do not match the canonical context — a forged summary`);
      }
    }
    if (!rec) {
      problems.push(`${ctag} is MISSING from the raw invocation record`);
      continue;
    }
    if (rec.cwdRel !== c.cwdRel) problems.push(`${ctag}.cwdRel ${JSON.stringify(rec.cwdRel ?? null)} != canonical ${JSON.stringify(c.cwdRel)}`);
    if (rec.kind !== c.kind) problems.push(`${ctag}.kind ${JSON.stringify(rec.kind ?? null)} != canonical ${JSON.stringify(c.kind)}`);
    // A failed per-context obligation may NEVER be hidden behind a passing physical
    // status: the raw context record must itself be `ok`.
    if (rec.status !== 'ok') problems.push(`${ctag}.status ${JSON.stringify(rec.status ?? null)} is not "ok" — a failed per-context obligation cannot be hidden behind a passing physical status`);
    // Validate the complete rel + declaration provenance against the FRESH canonical
    // declarations — not just a copied fingerprint/ref list.
    if (rec.rel !== c.rel) problems.push(`${ctag}.rel ${JSON.stringify(rec.rel ?? null)} != canonical ${JSON.stringify(c.rel)}`);
    const normDecl = (v) => JSON.stringify(Array.isArray(v) ? v : []);
    if (normDecl(rec.declarations) !== normDecl(c.declarations)) problems.push(`${ctag} complete declarations do not match the canonical current-source context — a partial/forged declaration set`);
    if (rec.fingerprint !== c.fingerprint) problems.push(`${ctag}.fingerprint does not match the canonical current-source provenance — a stale/forged context`);
    const aRefs = (Array.isArray(rec.declarationRefs) ? rec.declarationRefs : []).map(String).sort(cmp);
    if (JSON.stringify(aRefs) !== JSON.stringify(c.declarationRefs.slice().sort(cmp))) {
      problems.push(`${ctag} declaration reference set does not match the canonical context — a partial reference`);
    }
    const aMan = (Array.isArray(rec.manifestInputs) ? rec.manifestInputs : [])
      .map((m) => ({ rel: (m && m.rel) ?? null, sha256: (m && m.sha256) ?? null }))
      .sort((x, y) => cmp(String(x.rel), String(y.rel)));
    const cMan = c.manifestInputs.map((m) => ({ rel: m.rel, sha256: m.sha256 }));
    if (JSON.stringify(aMan) !== JSON.stringify(cMan)) {
      problems.push(`${ctag} controlling manifest-input hashes do not match the canonical context — stale evidence`);
    }
    const invs = rec.invocations;
    if (!invs || typeof invs !== 'object') {
      problems.push(`${ctag} raw context must carry an invocations object`);
      continue;
    }
    requireInvocation(ctag, 'noArgs', invs.noArgs, r, { mustEndWith: r.path, args: [] }, problems, ctx, c, identityIndex);
    requireInvocation(ctag, 'help', invs.help, r, { mustEndWith: '--help', args: ['--help'] }, problems, ctx, c, identityIndex);
    requireInvocation(ctag, 'unknown', invs.unknown, r, { mustEndWith: SMOKE_UNKNOWN_FLAG, args: [SMOKE_UNKNOWN_FLAG] }, problems, ctx, c, identityIndex);
  }
  for (const rec of recCtxs) {
    if (!canonical.some((c) => c.contextKey === (rec && rec.contextKey))) {
      problems.push(`${tag} raw record declares context ${JSON.stringify(rec && rec.contextKey)} which is not a canonical current-source context — an unexpected/foreign context`);
    }
  }
}

/**
 * Bind a committed/owned raw STRACE trace through the STREAMING capability and
 * parse it in bounded buffers via the ONE canonical parser. Review round 12 +
 * PR2309 follow-on: the raw syscall trace must be a real committed/owned, hashed,
 * non-empty artifact parsed by the canonical streaming reader — NEVER read whole
 * into a Buffer/string and NEVER hashed with a generic whole-file `sha256File`.
 * A missing streaming capability FAILS CLOSED.
 * Returns the streamed parse `{sha256, bytes, network, write, permittedWrites,
 * execs}` (hash/bytes re-verified against the recorded digest) or null.
 */
function bindRawTraceStream(tag, pathKey, hashKey, r, ctx, problems) {
  const rel = r[pathKey];
  const hash = r[hashKey];
  if (!isNonEmptyStr(rel)) {
    problems.push(`${tag}.${pathKey} is required — the raw syscall trace text must be referenced`);
    return null;
  }
  if (!isSafeRelPath(rel)) {
    problems.push(`${tag}.${pathKey} ${JSON.stringify(rel)} must be a repo-relative path inside the repository`);
    return null;
  }
  if (!ctx || typeof ctx !== 'object') {
    problems.push(`${tag}.${pathKey} cannot be bound (no evidence context) — fail closed`);
    return null;
  }
  if (typeof ctx.contained === 'function' && !ctx.contained(rel)) {
    problems.push(`${tag}.${pathKey} ${JSON.stringify(rel)} escapes the repository root — rejected`);
    return null;
  }
  if (!isHex64(hash)) {
    problems.push(`${tag}.${hashKey} must be a 64-char hex digest`);
    return null;
  }
  const liveMode = ctx.evidenceMode === 'owned-live-runtime';
  if (liveMode) {
    if (!rel.split('\\').join('/').startsWith(LIVE_EVIDENCE_ROOT)) {
      problems.push(`${tag}.${pathKey} ${JSON.stringify(rel)} is outside the owned live-evidence root ${JSON.stringify(LIVE_EVIDENCE_ROOT)} — live raw evidence must be task-owned`);
    }
  } else if (typeof ctx.trackedAndClean !== 'function') {
    problems.push(`${tag}.${pathKey} cannot be verified as committed (no tracking context) — fail closed`);
    return null;
  } else {
    const tc = ctx.trackedAndClean(rel);
    if (!tc || tc.tracked !== true) problems.push(`${tag}.${pathKey} ${JSON.stringify(rel)} is not a committed (tracked) file — untracked raw evidence is rejected`);
    else if (tc.clean !== true) problems.push(`${tag}.${pathKey} ${JSON.stringify(rel)} is modified relative to HEAD — the raw syscall trace was mutated`);
  }
  if (!ctx.root || typeof ctx.resolve !== 'function') {
    problems.push(`${tag}.${pathKey} cannot be resolved (no evidence root context) — fail closed`);
    return null;
  }
  // The trace MUST be read through the STREAMING capability (bounded buffers):
  // a whole-file read/hash is not accepted for a potentially hundreds-of-MB trace.
  if (typeof ctx.readAndParseTraceFileSync !== 'function') {
    problems.push(`${tag}.${pathKey} cannot be streamed/parsed (no streaming trace capability) — fail closed`);
    return null;
  }
  const abs = ctx.resolve(rel);
  let res;
  try {
    res = ctx.readAndParseTraceFileSync(abs);
  } catch (err) {
    problems.push(`${tag}.${pathKey} cannot be streamed: ${err.message}`);
    return null;
  }
  if (!res || typeof res !== 'object') {
    problems.push(`${tag}.${pathKey} streamed parse returned no result — fail closed`);
    return null;
  }
  if (!Number.isInteger(res.bytes) || res.bytes <= 0) {
    problems.push(`${tag}.${pathKey} is empty — an empty syscall trace is not evidence`);
    return null;
  }
  if (res.sha256 !== hash) {
    problems.push(`${tag}.${pathKey} sha256 ${res.sha256} != recorded ${hash} — the raw syscall trace was mutated or fabricated`);
    return null;
  }
  // Bind the recorded byte count to the INDEPENDENTLY streamed bytes (not merely a
  // nonempty trace): a forged `traceTextBytes` cannot pass against the real stream.
  if (Number.isInteger(r.traceTextBytes) && r.traceTextBytes !== res.bytes) {
    problems.push(`${tag}.traceTextBytes ${r.traceTextBytes} != independently streamed bytes ${res.bytes} — trace byte count is not reproducible`);
    return null;
  }
  return res;
}

/**
 * Shared raw-evidence check: containment + tracked/clean + real hashed bytes,
 * AND — when `requireJson` is set (raw invocation/audit/self-test records) —
 * parse the file as a JSON object. A non-JSON structured record is a failure:
 * root round 5 reproduced v3 accepting a tracked NON-JSON "audit".
 * Returns the parsed object when the bytes parse as a JSON object, else null.
 */
function checkRawEvidence(tag, pathKey, hashKey, r, rawLogHashes, ctx, problems, mapKey, requireJson = false) {
  const rel = r[pathKey];
  const hash = r[hashKey];
  if (!isNonEmptyStr(rel)) {
    problems.push(`${tag}.${pathKey} is required — the committed raw evidence must be referenced`);
    return null;
  }
  if (!isSafeRelPath(rel)) {
    problems.push(`${tag}.${pathKey} ${JSON.stringify(rel)} must be a repo-relative path inside the repository (absolute/traversal/outside paths are rejected)`);
    return null;
  }
  if (typeof ctx.contained === 'function' && !ctx.contained(rel)) {
    problems.push(`${tag}.${pathKey} ${JSON.stringify(rel)} escapes the repository root — rejected`);
    return null;
  }
  if (mapKey !== null && rawLogHashes && rawLogHashes[mapKey] !== hash) {
    problems.push(`${tag} rawLogHashes[${JSON.stringify(mapKey)}] ${JSON.stringify(rawLogHashes[mapKey])} != ${hashKey} ${JSON.stringify(hash)}`);
  }
  if (!isHex64(hash)) {
    problems.push(`${tag}.${hashKey} must be a 64-char hex digest`);
    return null;
  }
  const liveMode = Boolean(ctx) && ctx.evidenceMode === 'owned-live-runtime';
  if (liveMode) {
    // A bounded CURRENT run produces fresh, task-owned raw artifacts that are
    // not (and cannot yet be) committed+clean. Confine them to the owned live
    // dir; existence/hash/containment are still enforced below. Arbitrary
    // untracked paths are NOT accepted.
    if (!rel.split('\\').join('/').startsWith(LIVE_EVIDENCE_ROOT)) {
      problems.push(`${tag}.${pathKey} ${JSON.stringify(rel)} is outside the owned live-evidence root ${JSON.stringify(LIVE_EVIDENCE_ROOT)} — live raw evidence must be task-owned`);
    }
  } else if (typeof ctx.trackedAndClean !== 'function') {
    problems.push(`${tag}.${pathKey} cannot be verified as committed (no tracking context) — fail closed`);
    return null;
  } else {
    const tc = ctx.trackedAndClean(rel);
    if (!tc || tc.tracked !== true) problems.push(`${tag}.${pathKey} ${JSON.stringify(rel)} is not a committed (tracked) file — untracked raw evidence is rejected`);
    else if (tc.clean !== true) problems.push(`${tag}.${pathKey} ${JSON.stringify(rel)} is modified relative to HEAD — the raw evidence was mutated`);
  }

  if (!ctx.root) {
    problems.push(`${tag}.${pathKey} cannot be hashed (no evidence root context) — fail closed`);
    return null;
  }
  if (typeof ctx.existsSync !== 'function' || typeof ctx.sha256File !== 'function') {
    problems.push(`${tag}.${pathKey} cannot be hashed (missing hashing context) — fail closed`);
    return null;
  }
  const abs = ctx.resolve ? ctx.resolve(rel) : rel;
  if (!ctx.existsSync(abs)) {
    problems.push(`${tag}.${pathKey} not found at ${rel} — absent raw evidence cannot be accepted`);
    return null;
  }
  const actual = ctx.sha256File(abs);
  if (actual !== hash) {
    problems.push(`${tag}.${pathKey} sha256 ${actual} != recorded ${hash} — the raw evidence was mutated or fabricated`);
    return null;
  }
  // The raw smoke log is free text; it is only required to exist and be hashed.
  if (!requireJson) return null;
  // Parse the structured raw record: a hashed-but-non-JSON file is not a
  // native invocation/audit record.
  if (typeof ctx.readFile !== 'function') {
    problems.push(`${tag}.${pathKey} cannot be parsed (no read context) — fail closed`);
    return null;
  }
  let text;
  try {
    text = ctx.readFile(abs);
  } catch (err) {
    problems.push(`${tag}.${pathKey} cannot be read: ${err.message}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    problems.push(`${tag}.${pathKey} is not valid JSON — a raw invocation/audit record must be a structured JSON object (fabricated text is rejected)`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push(`${tag}.${pathKey} must parse to a JSON object`);
    return null;
  }
  return parsed;
}
