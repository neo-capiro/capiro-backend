#!/usr/bin/env node
/**
 * verify-baseline.mjs — fail-closed verifier for the measured coverage
 * baseline (docs/plans/cleanup1-coverage-baseline.json). CleanUp1 §5.2/§10.
 *
 * Independent review round 2 reproduced THREE invalid manifests that the
 * previous implementation accepted (exit 0 / VERIFIED):
 *   1. one invented package, no metrics, no reports, omitting every required target;
 *   2. a native suite exit code of 1 labelled `measured-green`;
 *   3. a nonexistent raw report referenced by an invented sha256.
 * A recomputable `resultsSha256` over a hand-edited manifest is NOT immutable
 * evidence, and requiring the historical baseline's runSha to equal every
 * future HEAD is a self-reference error.
 *
 * So acceptance now requires, all as HARD failures:
 *   - the manifest declares schema/version/kind and a non-empty result set;
 *   - the result set is EXACTLY the currently resolved required coverage scope
 *     (four Node targets — API/Web/Workspace/OnboardWeb — plus Python), each
 *     present exactly once, no missing and no silently added scope;
 *   - every result's suite exit code is the integer 0 and status is
 *     `measured-green`; the manifest `green` flag is true;
 *   - every result carries a COMPLETE, finite metric block (statements, lines,
 *     branches — including Python branch coverage — and functions for the JS
 *     runners) with a consistent covered/total/pct relationship;
 *   - every result's raw report really exists at the recorded path, its
 *     sha256 matches, and the recorded metrics EXACTLY re-derive from that raw
 *     report (a fabricated summary cannot match a real file);
 *   - the manifest is anchored to the MEASURED SOURCE: a real commit that is an
 *     ancestor of HEAD, whose coverage-relevant source/config fingerprint
 *     re-derives from git. This stays valid across later evidence-only commits
 *     and later phases — it does NOT require runSha === HEAD.
 *
 * Two manifest kinds are distinguished:
 *   - `historical-floor` — the committed, immutable floor (default). Anchored to
 *     its measured source; never compared against the current HEAD.
 *   - `current-run`       — a fresh measurement; must be from --expect-sha.
 *
 * Usage:
 *   node scripts/cleanup-gates/verify-baseline.mjs
 *        [--baseline docs/plans/cleanup1-coverage-baseline.json]
 *        [--kind historical-floor|current-run|auto]
 *        [--expect-sha <sha>] [--require-tracked] [--json <out>] [--quiet]
 * Exit: 0 verified green + complete + anchored; 1 rejected; 2 usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, guardRef, withUsage } from './lib/cli.mjs';
import { BASELINE_JSON, resolveRequiredCoverageScope } from './gate-config.mjs';
import { readMetrics, validateMetrics, sha256File } from './lib/metrics.mjs';
import { fingerprintAt, commitExists, isAncestor, trackedAndClean, headSha, provenancePaths, FINGERPRINT_ALGORITHM } from './lib/provenance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const SUPPORTED_SCHEMA = 'capiro.cleanup1-coverage-baseline';
const SUPPORTED_VERSION = 2;
const KINDS = new Set(['historical-floor', 'current-run']);

const USAGE =
  'usage: node scripts/cleanup-gates/verify-baseline.mjs [--baseline path] [--kind historical-floor|current-run|auto] [--expect-sha sha] [--require-tracked] [--json out] [--quiet]';
const ARG_SPEC = {
  baseline: { flag: 'baseline', type: 'string', default: BASELINE_JSON },
  kind: { flag: 'kind', type: 'string', default: 'historical-floor', choices: ['historical-floor', 'current-run', 'auto'] },
  expectSha: { flag: 'expect-sha', type: 'string', default: null },
  requireTracked: { flag: 'require-tracked', type: 'flag', default: false },
  json: { flag: 'json', type: 'string', default: null },
  quiet: { flag: 'quiet', type: 'flag', default: false },
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Canonical hash over the recorded results (deterministic ordering). */
export function resultsHash(results) {
  return sha256(Buffer.from(JSON.stringify(results)));
}

function insideRoot(p) {
  const rel = path.relative(ROOT, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Deep-equal the recorded metrics against a freshly re-derived block. */
function metricsEqual(a, b) {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}
function normalise(m) {
  if (!m || typeof m !== 'object') return m;
  const out = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k];
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2), ARG_SPEC);
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }
  if (args.expectSha) args.expectSha = guardRef(args.expectSha, { name: '--expect-sha' });

  const problems = [];
  const abs = path.resolve(ROOT, args.baseline);

  // ---- Required scope (resolved from current source) -----------------------
  const scope = resolveRequiredCoverageScope(ROOT);
  for (const p of scope.problems) problems.push(`required-scope: ${p}`);
  const requiredByPackage = new Map(scope.required.map((r) => [r.package, r]));

  // ---- Load the manifest ---------------------------------------------------
  let manifest = null;
  let baselineFileSha = null;
  if (!fs.existsSync(abs)) {
    problems.push(`baseline not found: ${args.baseline}`);
  } else {
    baselineFileSha = sha256File(abs);
    try {
      manifest = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      problems.push(`baseline is not valid JSON: ${err.message}`);
    }
  }

  const head = headSha(ROOT);
  const out = {
    baseline: args.baseline,
    baselineFileSha256: baselineFileSha,
    kind: args.kind,
    head,
    expectSha: args.expectSha,
    ok: false,
    problems,
  };

  if (manifest) {
    out.runSha = manifest.runSha ?? null;
    out.kindResolved = manifest.kind ?? null;
    out.resultsSha256 = manifest.resultsSha256 ?? null;

    if (manifest.schema !== SUPPORTED_SCHEMA) problems.push(`schema must be ${JSON.stringify(SUPPORTED_SCHEMA)} (got ${JSON.stringify(manifest.schema)})`);
    if (manifest.schemaVersion !== SUPPORTED_VERSION) problems.push(`schemaVersion must be ${SUPPORTED_VERSION} (got ${JSON.stringify(manifest.schemaVersion)})`);
    if (!KINDS.has(manifest.kind)) problems.push(`kind must be one of ${[...KINDS].join(', ')} (got ${JSON.stringify(manifest.kind)})`);
    if (args.kind !== 'auto' && manifest.kind !== args.kind) {
      problems.push(`manifest kind ${JSON.stringify(manifest.kind)} != requested ${JSON.stringify(args.kind)}`);
    }

    // ---- Results set must be EXACTLY the required scope --------------------
    const results = manifest.results;
    if (!Array.isArray(results) || results.length === 0) {
      problems.push('results must be a non-empty array');
    } else {
      const seen = new Set();
      for (const r of results) {
        if (!r || typeof r !== 'object') continue;
        if (typeof r.package !== 'string' || !r.package) continue;
        if (seen.has(r.package)) problems.push(`duplicate result for package ${r.package}`);
        seen.add(r.package);
        if (!requiredByPackage.has(r.package)) problems.push(`unexpected result package ${JSON.stringify(r.package)} — not part of the resolved required coverage scope`);
      }
      for (const req of scope.required) {
        if (!seen.has(req.package)) problems.push(`missing required coverage result for ${req.package} (${req.packageDir}) — the required scope is incomplete`);
      }
    }

    // ---- Tamper hash (defence in depth; not the sole immutability proof) ---
    if (Array.isArray(results) && manifest.resultsSha256 !== resultsHash(results)) {
      problems.push(
        `resultsSha256 mismatch: recorded ${JSON.stringify(manifest.resultsSha256)} but recomputed ${resultsHash(results)} — the manifest was mutated or truncated`,
      );
    }

    // ---- Per-result completeness ------------------------------------------
    if (Array.isArray(results)) {
      results.forEach((r, i) => {
        const tag = `results[${i}]`;
        if (!r || typeof r !== 'object') return problems.push(`${tag} is not an object`);
        const req = typeof r.package === 'string' ? requiredByPackage.get(r.package) : null;
        if (req) {
          if (r.packageDir !== req.packageDir) problems.push(`${tag} (${r.package}).packageDir ${JSON.stringify(r.packageDir)} != ${req.packageDir}`);
          if (r.runner !== req.runner) problems.push(`${tag} (${r.package}).runner ${JSON.stringify(r.runner)} != ${req.runner}`);
        }
        if (typeof r.runner !== 'string' || !r.runner) problems.push(`${tag}.runner is required`);

        // Native exit: integer 0, not merely truthy/numeric.
        if (r.suiteExitCode !== 0) {
          problems.push(`${tag} (${r.package}).suiteExitCode must be the integer 0 (got ${JSON.stringify(r.suiteExitCode)}) — a non-zero native exit is NOT green`);
        }

        if (r.status !== 'measured-green') {
          problems.push(`${tag} (${r.package}) is ${JSON.stringify(r.status)} — diagnostic/red measurements are not an accepted baseline`);
        }

        problems.push(...validateMetrics(`${tag} (${r.package}).metrics`, r.metrics, { runner: r.runner }));

        // Raw report must exist, hash-match, and re-derive the recorded metrics.
        if (typeof r.reportPath !== 'string' || !r.reportPath) {
          problems.push(`${tag} (${r.package}).reportPath is required — the raw report must be available`);
        } else {
          const reportAbs = path.resolve(ROOT, r.reportPath);
          if (!insideRoot(reportAbs)) {
            problems.push(`${tag}.reportPath escapes the repository: ${r.reportPath}`);
          } else if (!fs.existsSync(reportAbs)) {
            problems.push(`${tag} (${r.package}) raw report not found at ${r.reportPath} — absent reports cannot be accepted`);
          } else {
            const actualSha = sha256File(reportAbs);
            if (typeof r.reportSha256 !== 'string' || r.reportSha256 !== actualSha) {
              problems.push(`${tag} (${r.package}).reportSha256 ${JSON.stringify(r.reportSha256)} != actual ${actualSha} — report hash mismatch/fabrication`);
            }
            if (req) {
              try {
                const recomputed = readMetrics(req.runner, reportAbs);
                if (!metricsEqual(r.metrics, recomputed)) {
                  problems.push(`${tag} (${r.package}) recorded metrics do not match the raw report — the summary was not derived from this report`);
                }
              } catch (err) {
                problems.push(`${tag} (${r.package}) raw report is unreadable: ${err.message}`);
              }
            }
          }
        }
      });
    }

    if (manifest.green !== true) problems.push('manifest green flag is not true — the baseline is explicitly pending, not accepted');
    if (!manifest.runSha) problems.push('manifest runSha is required');

    // ---- Provenance: anchored to the MEASURED SOURCE, not to HEAD ----------
    const src = manifest.measuredSource;
    if (!src || typeof src !== 'object') {
      problems.push('measuredSource is required — the baseline must be anchored to the measured source (not merely carry a runSha)');
    } else {
      const { sha, fingerprint, fingerprintAlgorithm, paths } = src;
      // The COMPLETE measured-source input set is re-derived from the fixed
      // MEASURED_SOURCE_SPECS constant, NOT trusted from the manifest. A
      // manifest must never be its own completeness proof (review round 3).
      const expectedSpecs = provenancePaths(ROOT);
      if (typeof sha !== 'string' || !sha) problems.push('measuredSource.sha is required');
      if (fingerprintAlgorithm !== FINGERPRINT_ALGORITHM) problems.push(`measuredSource.fingerprintAlgorithm must be ${JSON.stringify(FINGERPRINT_ALGORITHM)}`);
      if (!Array.isArray(paths) || paths.length === 0) {
        problems.push('measuredSource.paths must list the measured source/config input specs');
      } else {
        const recorded = new Set(paths);
        const missing = expectedSpecs.filter((s) => !recorded.has(s));
        if (missing.length) {
          problems.push(
            `measuredSource.paths omits required source/config input spec(s): ${missing.join(', ')} — the recorded path list is incomplete (an API source change could leave the fingerprint unchanged)`,
          );
        }
      }
      if (typeof fingerprint !== 'string' || !fingerprint) problems.push('measuredSource.fingerprint is required');
      if (typeof sha === 'string' && sha) {
        if (!commitExists(ROOT, sha)) {
          problems.push(`measuredSource.sha ${sha} is not a commit in this repository`);
        } else if (head && !isAncestor(ROOT, sha, head)) {
          problems.push(`measuredSource.sha ${sha} is not an ancestor of HEAD ${head} — the baseline is not from this lineage`);
        } else if (typeof fingerprint === 'string') {
          // Recompute over the DERIVED spec set so the completeness cannot be
          // narrowed by the manifest's own path list.
          const re = fingerprintAt(ROOT, sha, expectedSpecs);
          if (!re.ok) problems.push(`cannot recompute the measured-source fingerprint: ${re.error}`);
          else if (!re.entries || re.entries.length === 0) problems.push(`measured-source fingerprint at ${sha} resolved zero source files — the measured input set is empty`);
          else if (re.fingerprint !== fingerprint) {
            problems.push(`measured-source fingerprint mismatch: recorded ${fingerprint} but ${sha} re-derives ${re.fingerprint} — the baseline is not anchored to this source`);
          }
        }
      }
    }

    // ---- Kind-specific current-run proof ----------------------------------
    if (manifest.kind === 'current-run') {
      if (!args.expectSha) {
        problems.push('current-run manifest requires --expect-sha (the commit this run measured)');
      } else if (manifest.runSha !== args.expectSha) {
        problems.push(`current-run runSha ${JSON.stringify(manifest.runSha)} != --expect-sha ${args.expectSha}`);
      }
      if (manifest.runSha && manifest.measuredSource && manifest.measuredSource.sha && manifest.runSha !== manifest.measuredSource.sha) {
        problems.push(`current-run runSha ${manifest.runSha} != measuredSource.sha ${manifest.measuredSource.sha}`);
      }
    }
    // A historical floor is deliberately NOT compared to HEAD: requiring
    // runSha === HEAD would make the baseline self-referential and break every
    // later evidence-only or refactor commit.

    // ---- Optional: the acceptance baseline must be committed & unmodified --
    if (args.requireTracked) {
      const st = trackedAndClean(ROOT, path.relative(ROOT, abs).split(path.sep).join('/'));
      if (!st.tracked) problems.push(`baseline ${args.baseline} is not committed — an acceptance baseline must be tracked by git`);
      else if (!st.clean) problems.push(`baseline ${args.baseline} differs from its committed HEAD blob — a hand-edited local manifest is not immutable evidence`);
    }
  }

  out.ok = problems.length === 0;
  if (args.json) {
    const p = path.resolve(ROOT, args.json);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n');
  }
  if (!args.quiet) {
    process.stdout.write(`[baseline] ${out.ok ? 'VERIFIED' : `REJECTED (${problems.length})`} ${args.baseline}\n`);
    process.stdout.write(`[baseline] file sha256=${baselineFileSha}\n`);
    for (const p of problems) process.stdout.write(`[baseline]   - ${p}\n`);
  }
  process.exit(out.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) withUsage(main, USAGE)();
