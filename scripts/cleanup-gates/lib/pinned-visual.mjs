/**
 * Pinned portable VISUAL lane for the CleanUp1 gate (CleanUp1 §8, round 60).
 *
 * The e2e acceptance requirement is satisfied ONLY by evidence the visual
 * lane's portable PINNED runner produced (apps/e2e/linux/run-linux-capture.sh
 * regression → apps/e2e/scripts/regression.mjs). A bare-host `pnpm --filter
 * @capiro/e2e test` run is NOT the pinned image, so it never counts.
 *
 * This module is PURE: it never launches a browser and never spawns Docker. It
 *   1. builds the argv that invokes the portable Linux runner WITHOUT
 *      interpolating any path/ref into a shell string (Linux = bash argv;
 *      Windows = explicit Git Bash with a fixed `pwd -W` bridge and MSYS path
 *      conversion disabled), and
 *   2. RE-DERIVES the pinned visual REGRESSION evidence from an INDEPENDENTLY
 *      SUPPLIED context (`ctx`) built by the GATE from ACTUAL files and the
 *      owned current run — so a hand-written/invented report, a self-attested
 *      boolean, a bare-host run, a mutable baseline, a changed renderer or a
 *      changed source cannot pass.
 *
 * Round-60 correction over the previous version: the validator used to accept
 * an invented JSON object that merely carried plausible booleans/digests and
 * only cross-checked the image. It now REQUIREs the actual current
 * head/tree/source fingerprint, the raw `--list`/run report BYTES for BOTH the
 * route AND the separately-discovered onboarding stage, the actual baseline
 * manifest + every PNG byte hash (before AND after), guardBefore/After, and a
 * complete `identity`/attachment — all re-derived from `ctx` real files with the
 * canonical Playwright kernel. A missing context piece FAILS CLOSED.
 *
 * Comparison policy and case identities are the SAME contract the visual lane's
 * repeat-proof uses (0.002 maxDiffPixelRatio / 0.2 threshold), through the ONE
 * shared renderer/context kernel (apps/e2e/lib/renderer-contract.mjs).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererCanonical, rendererContractProblems, rendererBindingProblems } from '../../../apps/e2e/lib/renderer-contract.mjs';
import { playwrightExecutionSummary, playwrightDiscoveredMultiset } from '../../../apps/e2e/lib/playwright-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Round-60 ROOT fix: this file lives at scripts/cleanup-gates/lib/, so the repo
// root is THREE levels up (previously TWO, which resolved to /scripts).
const ROOT = path.resolve(HERE, '..', '..', '..');

export const PINNED_VISUAL_SCHEMA = 'capiro.cleanup1.visual-regression.v1';
export const PINNED_VISUAL_MODE = 'regression';

/** The exact plan comparison policy (CleanUp1 §8.5). */
export const PINNED_COMPARISON = Object.freeze({ maxDiffPixelRatio: 0.002, threshold: 0.2 });

/**
 * The EXACT immutable rendering image already configured for the visual lane.
 * The env value (set by the workflow) wins so the workflow is the single source
 * of truth; the frozen literal is the documented default so the gate can still
 * name the required identity when the env is absent.
 */
export const PINNED_IMAGE_FALLBACK = 'mcr.microsoft.com/playwright@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7';
export const PINNED_IMAGE_DIGEST_FALLBACK = 'sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7';

export const PINNED_VISUAL_RUNNER_REL = 'apps/e2e/linux/run-linux-capture.sh';
export const PINNED_VISUAL_REGRESSION_RUNNER_REL = 'apps/e2e/linux/container-regression.sh';

/** Stages a regression run must have produced, in order. */
export const REQUIRED_STAGES = Object.freeze(['route-comparison', 'onboard-smoke']);

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const IMG_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isHex40(v) {
  return typeof v === 'string' && HEX40.test(v);
}

export function isHex64(v) {
  return typeof v === 'string' && HEX64.test(v);
}

export function pinnedImageRef(env = process.env) {
  return env.CAPIRO_VISUAL_IMAGE || PINNED_IMAGE_FALLBACK;
}

export function pinnedImageDigest(env = process.env) {
  return env.CAPIRO_VISUAL_IMAGE_DIGEST || PINNED_IMAGE_DIGEST_FALLBACK;
}

/** Absolute path of the portable visual runner. */
export function pinnedVisualRunner(root = ROOT) {
  return path.join(root, PINNED_VISUAL_RUNNER_REL);
}

/** Re-exported from the ONE shared renderer/context kernel. */
export { rendererCanonical };

/**
 * Cross-worktree normalized visual-suite identity. The SAME logical visual file
 * from two different worktree roots (two checkout roots on disk) must compare
 * equal; a raw absolute path from worktree A can never equal one from worktree
 * B, so the path is made package-relative posix.
 */
export function normalizeVisualSuite(rawPath, packageDirAbs, packageDirRel) {
  if (rawPath == null || rawPath === '') return '';
  let s = String(rawPath).split('\\').join('/');
  const anchors = [];
  if (packageDirAbs) anchors.push(String(packageDirAbs).split('\\').join('/').replace(/\/+$/, ''));
  if (packageDirRel) anchors.push(String(packageDirRel).split('\\').join('/').replace(/\/+$/, ''));
  for (const anchor of anchors) {
    if (!anchor) continue;
    if (s === anchor) return '';
    if (s.startsWith(anchor + '/')) return s.slice(anchor.length + 1);
  }
  for (const anchor of [packageDirRel && String(packageDirRel).replace(/\/+$/, ''), packageDirAbs && String(packageDirAbs).replace(/\/+$/, '')]) {
    if (!anchor) continue;
    const needle = '/' + anchor + '/';
    const idx = s.lastIndexOf(needle);
    if (idx !== -1) return s.slice(idx + needle.length);
  }
  return s;
}

/** File sha256 helper (pure read). */
export function sha256File(absPath) {
  return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function needCtx(push, ctx) {
  if (!ctx || typeof ctx !== 'object') {
    push('pinned-visual context (ROOT-built from actual files) is missing');
    return false;
  }
  const requiredFns = ['readText', 'exists', 'sha256'];
  const okFns = requiredFns.every((k) => typeof ctx[k] === 'function');
  if (!okFns) {
    push('pinned-visual context is incomplete (readText/exists/sha256 required)');
    return false;
  }
  return true;
}

function readJsonViaCtx(ctx, abs, push, what) {
  if (!ctx.exists(abs)) {
    push(`${what} not found at ${abs} (missing raw evidence — fail closed)`);
    return null;
  }
  let text;
  try {
    text = ctx.readText(abs);
  } catch (e) {
    push(`${what} unreadable: ${e.message}`);
    return null;
  }
  try {
    return { json: JSON.parse(text), text };
  } catch (e) {
    push(`${what} is not valid JSON: ${e.message}`);
    return null;
  }
}

/**
 * Validate the pinned visual REGRESSION evidence object against an INDEPENDENT
 * `ctx` built by the gate from actual files. Returns a list of problems (empty
 * = valid). FAIL-CLOSED on every review-required hole.
 */
export function validateRegressionEvidence(ev, ctx) {
  const problems = [];
  const push = (m) => problems.push(m);
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    return ['visual regression evidence is not an object'];
  }
  if (!needCtx(push, ctx)) return problems;

  if (ev.schema !== PINNED_VISUAL_SCHEMA) push(`visual regression schema must be ${PINNED_VISUAL_SCHEMA} (got ${JSON.stringify(ev.schema)})`);
  if (ev.mode !== PINNED_VISUAL_MODE) push(`visual regression mode must be ${PINNED_VISUAL_MODE} (got ${JSON.stringify(ev.mode)})`);

  // ---- image identity -------------------------------------------------------
  const img = ev.image ?? {};
  if (typeof img.ref !== 'string' || !/@sha256:[0-9a-f]{64}$/.test(img.ref)) push(`visual image ref must be a pinned digest ref (got ${JSON.stringify(img.ref)})`);
  if (!IMG_DIGEST.test(String(img.digest))) push(`visual image digest missing/invalid (got ${JSON.stringify(img.digest)})`);
  if (ctx.expectedImageRef && img.ref !== ctx.expectedImageRef) push(`visual image ref is not the configured pinned image: ${JSON.stringify(img.ref)} != ${ctx.expectedImageRef}`);
  if (ctx.expectedImageDigest && img.digest !== ctx.expectedImageDigest) push(`visual image digest is not the configured pinned digest: ${JSON.stringify(img.digest)} != ${ctx.expectedImageDigest}`);

  // ---- runtime: COMPLETE contract, bound to the image and the baseline ------
  const rt = ev.runtime;
  for (const p of rendererContractProblems(rt, { label: 'run renderer' })) push(p);
  if (rt && typeof rt === 'object' && rt.image?.digest !== img.digest) push('visual runtime.image.digest does not match the pinned image digest');

  // ---- baseline: actual manifest + ALL PNG bytes, immutable across the run --
  // The gate INDEPENDENTLY reads the ACTUAL baseline manifest (bytes + the
  // manifest's runtime/source capturingSha/fingerprint) and the ACTUAL PNG bytes
  // before AND after the run. Every observation is REQUIRED and shape-checked;
  // a missing/malformed observation is a hard problem, never a silently-skipped
  // comparison. The declared baseline identity must equal the REAL observation.
  const base = ev.baseline;
  const obsBefore = ctx.baselineBefore && typeof ctx.baselineBefore === 'object' ? ctx.baselineBefore : null;
  const obsAfter = ctx.baselineAfter && typeof ctx.baselineAfter === 'object' ? ctx.baselineAfter : null;
  const observationProblems = (obs, label) => {
    const out = [];
    if (!obs) { out.push(`baseline ${label} observation is missing from the context (gate must independently read the baseline before AND after)`); return out; }
    if (!isHex64(obs.manifestSha256)) out.push(`baseline ${label} observation manifestSha256 must be 64-hex (actual manifest bytes not hashed)`);
    if (!isHex64(obs.pngDigest)) out.push(`baseline ${label} observation PNG digest must be 64-hex (actual PNG bytes not hashed)`);
    if (!Number.isInteger(obs.pngCount) || obs.pngCount <= 0) out.push(`baseline ${label} observation PNG count must be a positive integer`);
    if (!obs.manifestRuntime || typeof obs.manifestRuntime !== 'object') out.push(`baseline ${label} observation must carry the ACTUAL baseline manifest runtime`);
    if (!isHex40(obs.capturingSha)) out.push(`baseline ${label} observation capturingSha must be 40-hex (actual manifest source.capturingSha not read)`);
    if (!isHex64(obs.sourceFingerprint)) out.push(`baseline ${label} observation sourceFingerprint must be 64-hex (actual manifest source fingerprint not read)`);
    return out;
  };
  for (const p of observationProblems(obsBefore, 'before')) push(p);
  for (const p of observationProblems(obsAfter, 'after')) push(p);
  if (obsBefore && obsAfter) {
    if (isHex64(obsBefore.manifestSha256) && isHex64(obsAfter.manifestSha256) && obsBefore.manifestSha256 !== obsAfter.manifestSha256) push('the ACTUAL baseline manifest bytes changed during the run (gate observed before != after)');
    if (isHex64(obsBefore.pngDigest) && isHex64(obsAfter.pngDigest) && obsBefore.pngDigest !== obsAfter.pngDigest) push('the ACTUAL baseline PNG bytes changed during the run (gate observed before != after)');
    if (Number.isInteger(obsBefore.pngCount) && Number.isInteger(obsAfter.pngCount) && obsBefore.pngCount !== obsAfter.pngCount) push('the ACTUAL baseline PNG count changed during the run (gate observed before != after)');
    if (isHex40(obsBefore.capturingSha) && isHex40(obsAfter.capturingSha) && obsBefore.capturingSha !== obsAfter.capturingSha) push('the ACTUAL baseline capturing commit changed during the run');
    if (isHex64(obsBefore.sourceFingerprint) && isHex64(obsAfter.sourceFingerprint) && obsBefore.sourceFingerprint !== obsAfter.sourceFingerprint) push('the ACTUAL baseline source fingerprint changed during the run');
  }
  if (!base || typeof base !== 'object') {
    push('visual baseline identity is missing');
  } else {
    if (!isHex64(base.manifestSha256)) push('visual baseline.manifestSha256 must be 64-hex');
    if (!isHex64(base.manifestSha256Before)) push('visual baseline.manifestSha256Before must be 64-hex');
    if (!isHex64(base.manifestSha256After)) push('visual baseline.manifestSha256After must be 64-hex');
    if (base.manifestSha256Before !== base.manifestSha256After) push('visual baseline manifest bytes changed during the run (mutable baseline)');
    if (base.manifestSha256Before !== base.manifestSha256) push('visual baseline manifest hash is inconsistent');
    if (obsBefore && isHex64(base.manifestSha256) && isHex64(obsBefore.manifestSha256) && base.manifestSha256 !== obsBefore.manifestSha256) {
      push('visual baseline.manifestSha256 does not match the ACTUAL baseline manifest bytes observed by the gate');
    }
    if (obsAfter && isHex64(base.manifestSha256After) && isHex64(obsAfter.manifestSha256) && base.manifestSha256After !== obsAfter.manifestSha256) {
      push('visual baseline.manifestSha256After does not match the ACTUAL baseline manifest bytes observed by the gate after the run');
    }
    if (base.immutable !== true) push('visual baseline is not declared immutable');
    if (!isHex64(base.sourceFingerprint)) push('visual baseline.sourceFingerprint must be 64-hex (historical capture source)');
    if (!isHex40(base.capturingSha)) push('visual baseline.capturingSha must be the historical 40-hex capturing commit');
    // The declared baseline identity must equal the ACTUAL manifest the gate read.
    if (obsBefore && isHex64(obsBefore.sourceFingerprint) && isHex64(base.sourceFingerprint) && base.sourceFingerprint !== obsBefore.sourceFingerprint) {
      push('visual baseline.sourceFingerprint does not match the ACTUAL baseline manifest source fingerprint');
    }
    if (obsBefore && isHex40(obsBefore.capturingSha) && isHex40(base.capturingSha) && base.capturingSha !== obsBefore.capturingSha) {
      push('visual baseline.capturingSha does not match the ACTUAL baseline manifest capturing commit');
    }
    // ALL PNG bytes (not just the manifest) must be immutable across the run and
    // must match the gate's actual observation.
    if (!isHex64(base.pngsDigest)) push('visual baseline.pngsDigest must be 64-hex (no actual PNG byte digest)');
    if (!Number.isInteger(base.pngsCount) || base.pngsCount <= 0) push('visual baseline.pngsCount must be a positive integer');
    if (base.pngsDigestBefore !== base.pngsDigestAfter) push('visual baseline PNG bytes changed during the run (mutable baseline PNGs)');
    if (base.pngsDigestBefore !== base.pngsDigest) push('visual baseline PNG digest is inconsistent');
    if (base.pngsImmutable !== true) push('visual baseline PNGs are not declared immutable');
    if (obsBefore && isHex64(base.pngsDigest) && isHex64(obsBefore.pngDigest) && base.pngsDigest !== obsBefore.pngDigest) {
      push('visual baseline.pngsDigest does not match the ACTUAL baseline PNG bytes observed by the gate before the run');
    }
    if (obsAfter && isHex64(base.pngsDigestAfter) && isHex64(obsAfter.pngDigest) && base.pngsDigestAfter !== obsAfter.pngDigest) {
      push('visual baseline.pngsDigestAfter does not match the ACTUAL baseline PNG bytes observed by the gate after the run');
    }
    if (obsBefore && Number.isInteger(base.pngsCount) && Number.isInteger(obsBefore.pngCount) && base.pngsCount !== obsBefore.pngCount) {
      push('visual baseline.pngsCount does not match the ACTUAL number of baseline PNGs');
    }
    // renderer binding — the run must have rendered with the BASELINE renderer,
    // and the declared baseline runtime must be the ACTUAL manifest runtime the
    // gate read (the complete historical renderer).
    if (!base.runtime || typeof base.runtime !== 'object') push('visual baseline.runtime is missing');
    else {
      for (const p of rendererBindingProblems(rt, base.runtime)) push(p);
      if (obsBefore && obsBefore.manifestRuntime && typeof obsBefore.manifestRuntime === 'object') {
        for (const p of rendererBindingProblems(base.runtime, obsBefore.manifestRuntime)) push(p);
      }
    }
  }

  // ---- policy ---------------------------------------------------------------
  const pol = ev.policy ?? {};
  if (pol.maxDiffPixelRatio !== PINNED_COMPARISON.maxDiffPixelRatio || pol.threshold !== PINNED_COMPARISON.threshold) {
    push(`visual comparison policy must be ${JSON.stringify(PINNED_COMPARISON)} (got ${JSON.stringify(pol)})`);
  }

  // ---- source unchanged during run + binding to the current verified archive -
  const src = ev.source ?? {};
  if (!isHex40(src.head)) push('visual source.head must be 40-hex');
  if (!isHex40(src.treeHash)) push('visual source.treeHash must be 40-hex');
  if (!isHex64(src.fingerprint)) push('visual source.fingerprint must be 64-hex');
  if (!isHex64(src.fingerprintBefore)) push('visual source.fingerprintBefore must be 64-hex');
  if (!isHex64(src.fingerprintAfter)) push('visual source.fingerprintAfter must be 64-hex');
  if (src.fingerprintBefore !== src.fingerprintAfter) push('visual source changed during the run (fingerprintBefore != fingerprintAfter)');
  if (src.unchanged !== true) push('visual source is not declared unchanged during the run');

  // The verified archive context the gate independently read. EVERY identity
  // field (head/tree/fingerprint) is MANDATORY and shape-checked — a missing,
  // malformed or foreign archive context refuses. A bare `fingerprint` presence
  // check is NOT sufficient (round 73).
  const arch = ctx.archive && typeof ctx.archive === 'object' ? ctx.archive : null;
  if (!arch) {
    push('verified archive context is missing (gate must supply the current archive head/tree/fingerprint)');
  } else {
    if (!isHex40(arch.head)) push('verified archive context head must be 40-hex (the actual archive manifest head was not read)');
    if (!isHex40(arch.treeHash)) push('verified archive context treeHash must be 40-hex (the actual archive manifest tree was not read)');
    if (!isHex64(arch.fingerprint)) push('verified archive context fingerprint must be 64-hex (the actual archive manifest fingerprint was not read)');
    if (isHex64(arch.fingerprint) && src.fingerprint !== arch.fingerprint) push('visual source.fingerprint is not bound to the current verified archive fingerprint');
    if (isHex40(arch.head) && src.head !== arch.head) push('visual source.head is not the current verified archive head');
    if (isHex40(arch.treeHash) && src.treeHash !== arch.treeHash) push('visual source.treeHash is not the current verified archive tree');
  }

  // The gate-observed source identity BEFORE / AFTER / CURRENT is MANDATORY and
  // shape-checked. The previous version only compared a field when it happened to
  // be present, silently skipping the comparison for a missing context (round
  // 73): a missing/malformed/foreign context must now REFUSE.
  const contextSourceProblems = (o, label) => {
    const out = [];
    if (!o || typeof o !== 'object') {
      out.push(`the gate-observed ${label} source context is missing (head/treeHash/fingerprint are required)`);
      return out;
    }
    if (!isHex40(o.head)) out.push(`gate-observed ${label} source head must be 40-hex`);
    if (!isHex40(o.treeHash)) out.push(`gate-observed ${label} source treeHash must be 40-hex`);
    if (!isHex64(o.fingerprint)) out.push(`gate-observed ${label} source fingerprint must be 64-hex`);
    return out;
  };
  for (const p of contextSourceProblems(ctx.sourceBefore, 'before')) push(p);
  for (const p of contextSourceProblems(ctx.sourceAfter, 'after')) push(p);
  for (const p of contextSourceProblems(ctx.current, 'current')) push(p);
  const sBefore = ctx.sourceBefore && typeof ctx.sourceBefore === 'object' ? ctx.sourceBefore : {};
  const sAfter = ctx.sourceAfter && typeof ctx.sourceAfter === 'object' ? ctx.sourceAfter : {};
  if (isHex64(sBefore.fingerprint) && src.fingerprintBefore !== sBefore.fingerprint) push('visual source.fingerprintBefore does not match the gate-observed source before the run');
  if (isHex64(sAfter.fingerprint) && src.fingerprintAfter !== sAfter.fingerprint) push('visual source.fingerprintAfter does not match the gate-observed source after the run');
  const current = ctx.current && typeof ctx.current === 'object' ? ctx.current : {};
  if (isHex40(current.head) && src.head !== current.head) push('visual source.head does not match the ACTUAL current commit');
  if (isHex40(current.treeHash) && src.treeHash !== current.treeHash) push('visual source.treeHash does not match the ACTUAL current tree');
  if (isHex64(current.fingerprint) && src.fingerprint !== current.fingerprint) push('visual source.fingerprint does not match the ACTUAL current source fingerprint');

  // ---- guards ---------------------------------------------------------------
  if (ev.guardBefore !== true) push('visual guardBefore is not TRUE');
  if (ev.guardAfter !== true) push('visual guardAfter is not TRUE');
  const g = ctx.guard && typeof ctx.guard === 'object' ? ctx.guard : {};
  if (g.before !== true) push('the gate-observed baseline guard BEFORE did not pass');
  if (g.after !== true) push('the gate-observed baseline guard AFTER did not pass');

  // ---- stages + RAW reports/lists, re-derived with the canonical kernel -----
  const stages = Array.isArray(ev.stages) ? ev.stages : [];
  if (stages.length === 0) push('visual run produced no stages');
  const byName = new Map(stages.map((s) => [s && s.name, s]));
  if (typeof ctx.reportDir !== 'string' || !ctx.reportDir) push('the raw report directory is missing from the context');
  const reportDir = typeof ctx.reportDir === 'string' ? ctx.reportDir : '';
  for (const name of REQUIRED_STAGES) {
    const st = byName.get(name);
    if (!st) {
      push(`visual stage is missing: ${name}`);
      continue;
    }
    if (!Number.isInteger(st.status)) push(`visual stage ${name} has no integer status`);
    else if (st.status !== 0) push(`visual stage ${name} exited ${st.status} (non-zero)`);
    if (st.signal != null) push(`visual stage ${name} was signalled (${st.signal})`);
    if (st.spawnError != null) push(`visual stage ${name} had a spawn error (${st.spawnError})`);
    if (st.report == null || typeof st.report !== 'object') push(`visual stage ${name} has no parsed report summary`);
    if (st.identityMatchesList !== true) push(`visual stage ${name} identity is not declared to match its --list discovery`);
    if (Array.isArray(st.agreementProblems) && st.agreementProblems.length > 0) {
      push(`visual stage ${name} reported agreement problems: ${st.agreementProblems.join('; ')}`);
    }
    if (!isHex64(st.reportSha256)) push(`visual stage ${name} reportSha256 must be 64-hex (raw run report not byte-bound)`);
    if (!isHex64(st.listSha256)) push(`visual stage ${name} listSha256 must be 64-hex (raw --list report not byte-bound)`);
    if (typeof st.reportName !== 'string' || !st.reportName) push(`visual stage ${name} has no raw report name`);
    if (typeof st.listName !== 'string' || !st.listName) push(`visual stage ${name} has no raw list name`);
    // Ownership shape: the raw report/list must be a BARE file name inside the
    // gate-owned report dir — a path/absolute/foreign name can never be read.
    const bareName = (v) => typeof v === 'string' && v.length > 0 && !v.includes('/') && !v.includes('\\') && v !== '.' && v !== '..';
    if (typeof st.reportName === 'string' && st.reportName && !bareName(st.reportName)) push(`visual stage ${name} reportName must be a bare file name inside the gate-owned report dir (got ${JSON.stringify(st.reportName)})`);
    if (typeof st.listName === 'string' && st.listName && !bareName(st.listName)) push(`visual stage ${name} listName must be a bare file name inside the gate-owned report dir (got ${JSON.stringify(st.listName)})`);
    if (!reportDir) continue;

    // Independently read the raw run report + raw list and re-derive identity.
    const runRead = st.reportName ? readJsonViaCtx(ctx, path.join(reportDir, st.reportName), push, `visual stage ${name} raw run report`) : null;
    const listRead = st.listName ? readJsonViaCtx(ctx, path.join(reportDir, st.listName), push, `visual stage ${name} raw --list report`) : null;
    if (runRead) {
      if (isHex64(st.reportSha256)) {
        const actual = ctx.sha256(path.join(reportDir, st.reportName));
        if (actual !== st.reportSha256) push(`visual stage ${name} raw run report BYTES do not match the declared reportSha256 (altered raw report)`);
      }
      const summary = playwrightExecutionSummary(runRead.json);
      if (typeof st.identityDigest !== 'string' || st.identityDigest !== summary.identityDigest) {
        push(`visual stage ${name} identityDigest does not equal the ACTUAL raw run report identity multiset`);
      }
      if (st.identityCount !== summary.count) push(`visual stage ${name} identityCount ${JSON.stringify(st.identityCount)} != actual ${summary.count}`);
      if (summary.unexpected !== 0) push(`visual stage ${name} raw run report has ${summary.unexpected} unexpected/failed case(s)`);
      if (summary.flaky !== 0) push(`visual stage ${name} raw run report has ${summary.flaky} flaky case(s)`);
      if (summary.skipped !== 0) push(`visual stage ${name} raw run report has ${summary.skipped} skipped case(s)`);
      if (summary.statsErrors !== 0) push(`visual stage ${name} raw native stats report ${summary.statsErrors} error(s)`);
      if (summary.statsExpected !== summary.count) push(`visual stage ${name} raw native stats expected ${summary.statsExpected} != observed ${summary.count}`);
      if (listRead) {
        const discovered = playwrightDiscoveredMultiset(listRead.json);
        if (discovered.length === 0) push(`visual stage ${name} raw --list discovery is EMPTY`);
        if (summary.identityDigest !== discovered.slice().sort().join('\n')) {
          push(`visual stage ${name} raw run report identity multiset does not equal its own raw --list discovery (duplicate/missing cases)`);
        }
        if (st.expectedCount !== discovered.length) push(`visual stage ${name} expectedCount ${JSON.stringify(st.expectedCount)} != actual list length ${discovered.length}`);
      }
      if (isHex64(st.listSha256) && listRead) {
        const actualList = ctx.sha256(path.join(reportDir, st.listName));
        if (actualList !== st.listSha256) push(`visual stage ${name} raw --list report BYTES do not match the declared listSha256 (altered raw list)`);
      }
    }
  }

  // ---- identity block -------------------------------------------------------
  const id = ev.identity ?? {};
  if (id.listDerived !== true) push('visual identity set is not derived from an independent --list');
  for (const k of ['count', 'expected', 'skipped', 'flaky', 'unexpected']) {
    if (!Number.isInteger(id[k]) || id[k] < 0) push(`visual identity.${k} must be a non-negative integer (got ${JSON.stringify(id[k])})`);
  }
  if (id.count !== id.expected) push(`visual identity set is incomplete: count ${id.count} != expected ${id.expected}`);
  if (id.count === 0) push('visual identity set is empty (zero tests)');
  if (id.skipped !== 0) push(`visual identity set has ${id.skipped} skipped case(s)`);
  if (id.flaky !== 0) push(`visual identity set has ${id.flaky} flaky case(s)`);
  if (id.unexpected !== 0) push(`visual identity set has ${id.unexpected} unexpected/pixel-drift case(s)`);
  if (id.complete !== true) push('visual identity set is not declared complete');
  const routeStage = byName.get('route-comparison');
  if (routeStage) {
    if (id.routeReport && routeStage.reportName && id.routeReport !== routeStage.reportName) push('visual identity.routeReport does not name the route stage raw report');
    if (id.routeList && routeStage.listName && id.routeList !== routeStage.listName) push('visual identity.routeList does not name the route stage raw list');
    if (Number.isInteger(id.count) && routeStage.identityCount !== undefined && id.count !== routeStage.identityCount) push('visual identity.count does not equal the route stage identity count');
  }

  // ---- onboarding is INDEPENDENTLY discovered + required --------------------
  const onboard = id.onboarding;
  if (!onboard || typeof onboard !== 'object') {
    push('visual onboarding identity is missing (the onboarding smoke must be separately discovered)');
  } else {
    for (const k of ['count', 'expected', 'skipped', 'flaky', 'unexpected']) {
      if (!Number.isInteger(onboard[k]) || onboard[k] < 0) push(`visual identity.onboarding.${k} must be a non-negative integer (got ${JSON.stringify(onboard[k])})`);
    }
    if (onboard.count === 0) push('visual onboarding identity set is empty (zero onboarding tests)');
    if (onboard.count !== onboard.expected) push(`visual onboarding identity set is incomplete: count ${onboard.count} != expected ${onboard.expected}`);
    if (onboard.skipped !== 0) push(`visual onboarding identity set has ${onboard.skipped} skipped case(s)`);
    if (onboard.flaky !== 0) push(`visual onboarding identity set has ${onboard.flaky} flaky case(s)`);
    if (onboard.unexpected !== 0) push(`visual onboarding identity set has ${onboard.unexpected} unexpected case(s)`);
    if (onboard.complete !== true) push('visual onboarding identity set is not declared complete');
    const onboardStage = byName.get('onboard-smoke');
    if (onboardStage) {
      if (onboard.report && onboardStage.reportName && onboard.report !== onboardStage.reportName) push('visual identity.onboarding.report does not name the onboarding stage raw report');
      if (onboard.list && onboardStage.listName && onboard.list !== onboardStage.listName) push('visual identity.onboarding.list does not name the onboarding stage raw list');
      if (Number.isInteger(onboard.count) && onboardStage.identityCount !== undefined && onboard.count !== onboardStage.identityCount) push('visual onboarding count does not equal the onboarding stage identity count');
      if (onboard.expected !== onboardStage.expectedCount) push('visual onboarding expected count does not equal its own --list discovery length');
    }
  }

  return problems;
}

/** MSYS env that disables `/c/...`-style path conversion for a Windows bridge. */
export const MSYS_DISABLE_ENV = Object.freeze({ MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' });

/** Locate an explicit Git Bash for the Windows runner bridge. */
export function gitBashPath(env = process.env, exists = fs.existsSync) {
  const candidates = [env.CAPIRO_GIT_BASH, 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'];
  for (const c of candidates) {
    if (c && exists(c)) return c;
  }
  return null;
}

/**
 * Build the argv that invokes the portable Linux runner WITHOUT interpolating
 * any path/ref into a shell string. Dynamic values are passed as POSITIONAL
 * argv, never spliced into `-c` text.
 *
 *   Linux/macOS : file='bash', args=[script, mode, ...positional]
 *   Windows     : file=<Git Bash>, a FIXED `pwd -W` bridge script, then
 *                 `bash <script> <mode> ...positional` as positional argv,
 *                 with MSYS path conversion disabled via env.
 *
 * @returns {{ file: string, args: string[], env: Record<string,string> }}
 */
export function buildPortableRunnerArgv({ script, mode, positional = [] }, { platform = process.platform, bashPath = null, env = process.env } = {}) {
  if (typeof script !== 'string' || script.length === 0) throw new Error('runner script path is required');
  if (typeof mode !== 'string' || mode.length === 0) throw new Error('runner mode is required');
  const tail = [script, mode, ...positional.map((v) => String(v))];
  if (platform !== 'win32') {
    return { file: 'bash', args: tail, env: {} };
  }
  const bash = bashPath || gitBashPath(env);
  if (!bash) throw new Error('Git Bash not found for the Windows portable-runner bridge (set CAPIRO_GIT_BASH)');
  const bridge = 'cd "$(pwd -W 2>/dev/null || pwd)" && exec bash "$@"';
  return { file: bash, args: ['--noprofile', '--norc', '-lc', bridge, 'bash', ...tail], env: { ...MSYS_DISABLE_ENV } };
}

export function visualHeadSha(root = ROOT) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  return res.status === 0 ? res.stdout.trim() : null;
}

export function visualTreeSha(root = ROOT) {
  const res = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  return res.status === 0 ? res.stdout.trim() : null;
}
