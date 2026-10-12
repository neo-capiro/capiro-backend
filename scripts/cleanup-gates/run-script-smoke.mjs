#!/usr/bin/env node
/**
 * run-script-smoke.mjs — CI-side adapter for the CleanUp1 §6.2 current-source
 * runtime smoke evidence (independent review round 5).
 *
 * Round 5 removed the CI lane's duplicate syscall runtime: this file no longer
 * re-implements a weaker harness (a require() preload that is NOT a syscall
 * audit, synthesised empty audits, "any output counts as usage", no real --help
 * invocation, "any definite exit is ok", Docker-CLI-timeout treated as proof the
 * container died, dirty-checkout source, per-file copies that break relative
 * imports, TS executed as plain Node, scope escape, and uncontained rmSync).
 *
 * There is ONE runtime emitter, owned by the execution lane (PR2224):
 *   scripts/cleanup-script-smoke/emit-evidence.mjs
 * It runs every discovered entry point under the strace attempt audit inside the
 * kernel-enforced `--network none --read-only` container, invoking the real
 * no-args AND --help identities, retaining the exact raw traces, and emits the
 * shared evidence artifact. This CI adapter:
 *
 *   1. REQUIRES the emitter to be present (fail closed when it is not — a
 *      missing runtime is a failure, never a skip and never a green);
 *   2. invokes it against THIS checkout (strict current committed source);
 *   3. re-validates the emitted artifact against CURRENT source with the shared
 *      fail-closed contract (`lib/smoke-evidence.mjs`, v4), which PARSES the
 *      committed raw invocation/audit records and requires both native
 *      identities, a proved `entrypointExecuted:true`, consistent argv/exits,
 *      and an exercised isolation self-test record;
 *   4. exits non-zero on any problem. It never writes a passing artifact
 *      itself and never fabricates evidence.
 *
 * Usage:
 *   node scripts/cleanup-gates/run-script-smoke.mjs [--root <dir>] [--out <json>]
 *   Exit: 0 the emitter's artifact validated against current source; 1 hard
 *         failure (emitter missing, it failed, or its artifact did not
 *         validate); 2 usage error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/cli.mjs';
import { SMOKE_EMITTER } from './gate-config.mjs';
import { sha256File, sha256Buffer } from './lib/metrics.mjs';
import { commitExists, isAncestor, headSha, fingerprintAt, provenancePaths, FINGERPRINT_ALGORITHM, trackedAndClean } from './lib/provenance.mjs';
import { contractFor } from './lib/script-contract.mjs';
import { readAndParseTraceFileSync } from '../cleanup-script-smoke/attempt-audit.mjs';
import { TS_RUNTIME_CLI_REL } from '../cleanup-script-smoke/ts-runtime.mjs';
import {
  validateSmokeEvidence,
  SMOKE_EVIDENCE_SCHEMA,
  SMOKE_EVIDENCE_VERSION,
  canonicalSmokeSubjects,
  canonicalSmokeSpecs,
} from './lib/smoke-evidence.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** The ONE runtime emitter, owned by the execution lane (PR2224). The path is
 * the CANONICAL value exported by gate-config (single source of truth), so the
 * CI lane and the gate config can never disagree about where the audited
 * emitter lives or how it is invoked. */
export const EMITTER_REL = SMOKE_EMITTER;
export const EVIDENCE_REL = 'docs/plans/cleanup1-script-smoke-evidence.json';

const USAGE = 'usage: node scripts/cleanup-gates/run-script-smoke.mjs [--root dir] [--out docs/plans/cleanup1-script-smoke-evidence.json]';
const ARG_SPEC = {
  root: { flag: 'root', type: 'string', default: REPO_ROOT },
  out: { flag: 'out', type: 'string', default: EVIDENCE_REL },
};

/** Repo-relative must resolve strictly inside root. */
function contained(root, rel) {
  const abs = path.resolve(root, rel);
  return abs === root || abs.startsWith(root + path.sep);
}

/**
 * The canonical §6.2 SMOKE subject/spec scope, re-derived from CURRENT source
 * by the ONE canonical discovery module owned by the execution lane
 * (scripts/cleanup-script-smoke/discover.mjs) — NOT a divergent CI copy
 * (round-30 alignment: "no divergent CI copies").
 *
 * Round 33 removes this adapter's duplicated projection: the SAME canonical
 * functions the shared contract module already uses (`canonicalSmokeSubjects` /
 * `canonicalSmokeSpecs` in `./lib/smoke-evidence.mjs`) are imported and
 * re-exported here under this adapter's existing public names, so there is ONE
 * discovery/classification implementation (never a second copy of the kind
 * filter or the tooling-spec union). The canonical derivation filters the
 * reviewed `discoverEntrypoints` to the emitter's EXECUTED + terminal-packet
 * kinds (`entrypoint` | `unsafe` | `undiscovered-declared`): helpers/tests are
 * excluded, and `unsafe` / `undiscovered-declared` packets stay IN scope and are
 * surfaced as non-`ok` (never a green result). `smokeScopeSpecs` is the smoke
 * tooling spec + every discovered subject path — NEVER the coverage specs.
 */
export const smokeScopeSubjects = canonicalSmokeSubjects;
export const smokeScopeSpecs = canonicalSmokeSpecs;

function buildCtx(root, artifact = null) {
  return {
    root,
    resolve: (p) => path.resolve(root, p),
    existsSync: (p) => fs.existsSync(p),
    sha256File,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    // v5 streaming trace capability (bounded buffers): the raw strace trace is
    // ONLY ever read/hashed/parsed through this — never a whole-file read.
    readAndParseTraceFileSync: (abs) => readAndParseTraceFileSync(abs),
    commitExists: (sha) => commitExists(root, sha),
    isAncestorOfHead: (sha) => {
      const h = headSha(root);
      return Boolean(h) && isAncestor(root, sha, h);
    },
    fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
    // Recompute over the ARTIFACT's explicit smoke scope (review round 11) — not
    // a producer-trusted hash and not the coverage specs. The scope must
    // independently equal the discovery subject set + smoke tooling.
    fingerprintAt: (sha) => fingerprintAt(root, sha, Array.isArray(artifact && artifact.source && artifact.source.specs) ? artifact.source.specs : []),
    // Round 30: the expected smoke scope is re-derived by the shared contract
    // module from CURRENT source via the ONE canonical discovery module. This
    // adapter supplies the same canonical scope explicitly (the unit-test seam
    // path of the validator); the gate's inline ctx omits the seam and the
    // validator derives it from ctx.root — both therefore use the ONE canonical
    // discovery, never a divergent CI copy.
    smokeScope: () => ({ subjects: smokeScopeSubjects(root), specs: smokeScopeSpecs(root) }),
    specExistsAtCommit: (sha, p) => spawnSync('git', ['cat-file', '-e', `${sha}:${p}`], { cwd: root, windowsHide: true }).status === 0,
    contractFor: (p) => contractFor(root, p, fs, path),
    sourceShaAt: (p, sha) => {
      const r = spawnSync('git', ['show', `${sha}:${p}`], { cwd: root, encoding: null, windowsHide: true });
      return r.status === 0 ? sha256Buffer(r.stdout) : null;
    },
    trackedAndClean: (p) => trackedAndClean(root, p),
    contained: (p) => contained(root, p),
    // This adapter runs the ONE emitter's BOUNDED CURRENT invocation (review
    // round 8): its raw artifacts are fresh and task-owned, not committed+clean,
    // so they are validated in `owned-live-runtime` mode (confined to the owned
    // live-evidence root). The committed historical floor stays strict.
    evidenceMode: 'owned-live-runtime',
    // The CONTROLLED native-bind topology this adapter runs (the installed-checkout
    // native-bind default): the verifier independently derives the exact absolute
    // native subject/cwd + `/tsruntime/<TS_RUNTIME_CLI_REL>` loader from CURRENT source
    // and this bound capability — never from an untrusted invocation self-report.
    nativeTopology: { mode: 'native-bind', tsRuntimeCliRel: TS_RUNTIME_CLI_REL },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2), ARG_SPEC);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const root = path.resolve(args.root);
  // --out MUST resolve strictly inside --root. The previous guard ANDed the
  // check behind `!contained(root, '.')`, which is always false (the root
  // always contains itself), so the containment check never ran and an
  // escaping `--out ../x.json` was silently accepted. Fail closed on its own.
  if (!contained(root, args.out)) {
    process.stderr.write(`[smoke] --out ${JSON.stringify(args.out)} must resolve inside --root ${JSON.stringify(root)}\n`);
    process.exit(2);
  }
  const emitterAbs = path.join(root, EMITTER_REL);
  if (!fs.existsSync(emitterAbs)) {
    process.stderr.write(
      `[smoke] FAIL-CLOSED: the ONE runtime emitter (${EMITTER_REL}) is absent from this checkout.\n` +
        '[smoke] The CI lane no longer runs a duplicate harness; the execution lane (PR2224) owns the\n' +
        '[smoke] audited emitter. CleanUp1 script-smoke acceptance stays RED until it is integrated.\n',
    );
    process.exit(1);
  }

  const outAbs = path.resolve(root, args.out);
  const emit = spawnSync(process.execPath, [emitterAbs, '--root', root, '--out', args.out], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'inherit',
  });
  if (emit.status !== 0) {
    process.stderr.write(`[smoke] emitter exited ${emit.status} — no accepted evidence (a runtime setup failure is a failure)\n`);
    process.exit(1);
  }
  if (!fs.existsSync(outAbs)) {
    process.stderr.write(`[smoke] emitter reported success but wrote no artifact at ${args.out}\n`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(outAbs, 'utf8'));
  } catch (err) {
    process.stderr.write(`[smoke] emitted artifact is not valid JSON: ${err.message}\n`);
    process.exit(1);
  }
  // Schema/version handoff: the emitter and this adapter share ONE contract
  // module (lib/smoke-evidence.mjs), but the artifact is produced by a
  // different lane, so pin the handoff explicitly here rather than relying on
  // the deeper validator to surface a lane mismatch as a field error.
  if (!parsed || typeof parsed !== 'object' || parsed.schema !== SMOKE_EVIDENCE_SCHEMA || parsed.schemaVersion !== SMOKE_EVIDENCE_VERSION) {
    process.stderr.write(
      `[smoke] SCHEMA HANDOFF MISMATCH: emitter artifact declares ` +
        `schema=${JSON.stringify(parsed && parsed.schema)} schemaVersion=${JSON.stringify(parsed && parsed.schemaVersion)}; ` +
        `this CI lane expects ${JSON.stringify(SMOKE_EVIDENCE_SCHEMA)} v${SMOKE_EVIDENCE_VERSION}.\n`,
    );
    process.exit(1);
  }
  const problems = validateSmokeEvidence(parsed, buildCtx(root, parsed));
  if (problems.length > 0) {
    process.stderr.write(`[smoke] emitted artifact FAILED the shared contract (${problems.length} problem(s)):\n`);
    for (const p of problems.slice(0, 40)) process.stderr.write(`        - ${p}\n`);
    process.exit(1);
  }
  process.stdout.write(`[smoke] current-source runtime smoke validated: ${parsed.results.length} subject(s)\n`);
  process.exit(0);
}

main();
