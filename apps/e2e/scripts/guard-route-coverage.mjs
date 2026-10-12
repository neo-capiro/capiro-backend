#!/usr/bin/env node
/**
 * Enforcing route-coverage / baseline-bijection guard (CleanUp1 §8.4, §8.5).
 *
 * Fails (non-zero) unless ALL of:
 *   - the inventory has zero fail-closed obligations;
 *   - every `captured` route × every project has exactly one baseline PNG
 *     (a captured route that redirects still requires its OWN requested-route
 *     PNG, with destination + content-sentinel provenance);
 *   - every declared `redirect-recorded` route × every project has exactly one
 *     `redirect_`-namespaced baseline PNG;
 *   - both conditional active-branch obligations have a baseline per project;
 *   - the baseline manifest has no extra/orphan captures (strict bijection);
 *   - every manifest sha256 matches the on-disk PNG bytes;
 *   - the manifest records the plan comparison policy (0.002 / 0.2);
 *   - the manifest's source identity is honest (capturingSha non-null, or an
 *     explicit worktree-clean/self-reference note).
 *
 * A new/renamed reachable route without a baseline, or a stale baseline without
 * a route, is a hard failure — never a silent pass.
 *
 * ROUND-13: the guard no longer trusts the committed route inventory blindly. It
 * RE-DERIVES the current router graph READ-ONLY with the SAME AST producer that
 * generated the inventory (lib/route-graph.mjs buildRouteGraphAsync) and fails
 * on any stale route / redirect / meaningful-parameter / obligation identity.
 * Generation timestamps and source LINE OFFSETS are ignored; reachable paths,
 * redirect targets, declared (parameter) shapes and every unresolved obligation
 * are NOT. A newly added route with no committed inventory entry (and therefore
 * no baseline) FAILS. The guard never writes the inventory and never mutates
 * source to make it match.
 * @cleanup-smoke noArgsExit=0 helpExit=0
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveCaptureObligations, validateManifestCaptures } from '../lib/capture-obligations.mjs';

const USAGE = 'Usage: node apps/e2e/scripts/guard-route-coverage.mjs [--help]';
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (args.length) {
  console.error(USAGE);
  console.error(`[guard] unknown argument: ${args.join(' ')}`);
  process.exit(2);
}
console.error(USAGE);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const inventory = JSON.parse(readFileSync(path.join(ROOT, 'routes.inventory.json'), 'utf8'));
const manifestPath = path.join(ROOT, 'baselines', 'manifest.json');
const sentinelsPath = path.join(ROOT, 'route-sentinels.json');

const errors = [];
const note = (m) => console.log(`  - ${m}`);

// 1. obligations
if ((inventory.obligations ?? []).length) {
  errors.push(`inventory has ${inventory.obligations.length} fail-closed obligation(s)`);
  for (const o of inventory.obligations) note(`obligation ${o.source}: ${o.reason}`);
}

// 2. every captured route MUST have an explicit, pinned content sentinel.
{
  const capturedPaths = inventory.routes.filter((r) => r.coverage === 'captured').map((r) => r.path);
  if (!existsSync(sentinelsPath)) {
    errors.push('route-sentinels.json is absent');
  } else {
    const s = JSON.parse(readFileSync(sentinelsPath, 'utf8'));
    const unresolved = s.unresolvedRoutes ?? [];
    if (unresolved.length) {
      errors.push(`route-sentinels.json has ${unresolved.length} UNRESOLVED route(s) (no pinned content — fail-closed)`);
      for (const p of unresolved) note(`unresolved sentinel: ${p}`);
    }
    for (const p of capturedPaths) if (!s.routes?.[p] && !s.redirects?.[p]) errors.push(`captured route ${p} has no sentinel entry (generic fallback forbidden)`);
    for (const p of Object.keys(s.routes ?? {})) {
      const e = s.routes[p];
      const dataOk = Array.isArray(e.ownEndpoints) && e.ownEndpoints.length > 0;
      const staticOk = e.staticOnly === true && Boolean(e.headingRe || e.textRe);
      if (!dataOk && !staticOk) errors.push(`sentinel ${p} is neither data-pinned (ownEndpoints) nor static-pinned (headingRe/textRe)`);
      if (!Array.isArray(e.forbid) || e.forbid.length === 0) errors.push(`sentinel ${p} forbids no absent/loading/error state`);
    }
  }
}

const projects = inventory.viewports.map((v) => v.name);
const captured = inventory.routes.filter((r) => r.coverage === 'captured');
const redirects = inventory.routes.filter((r) => r.coverage === 'redirect-recorded');

// 1b. The SAME derived PNG obligation contract the publisher enforces (captured
// routes + declared `redirect_` namespaced redirects + both conditional
// captures, with exact destination / content-sentinel provenance). Any
// malformed/unknown/duplicate/colliding input or missing destination sentinel
// fails here, before the manifest is even read.
const sentinelsDoc = existsSync(sentinelsPath) ? JSON.parse(readFileSync(sentinelsPath, 'utf8')) : {};
const obligations = deriveCaptureObligations({ inventory, sentinels: sentinelsDoc });
for (const p of obligations.problems) errors.push(`capture-obligation contract: ${p}`);

if (!existsSync(manifestPath)) {
  errors.push('baselines/manifest.json is absent (baselines not published)');
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // comparison policy recorded
  const cmp = manifest.comparison ?? {};
  if (cmp.maxDiffPixelRatio !== 0.002 || cmp.threshold !== 0.2) {
    errors.push(`manifest comparison policy must be maxDiffPixelRatio 0.002 / threshold 0.2, got ${JSON.stringify(cmp)}`);
  }
  // honest source identity (round-11): a complete measured fingerprint is
  // required, and an ACCEPTED manifest is never a dirty/forced capture.
  const src = manifest.source ?? {};
  if (typeof src.sourceFingerprint !== 'string' || !src.sourceFingerprint) {
    errors.push('manifest source identity is not honest (missing sourceFingerprint of the measured rendered inputs)');
  }
  if (src.worktreeCleanAtCapture !== true || src.capturingSha == null) {
    errors.push('manifest is not an accepted capture (worktreeCleanAtCapture !== true / capturingSha null) — dirty or forced captures may not be published');
  }
  if (manifest.runtimeKnown !== true) {
    errors.push('manifest runtime identity is not verified (runtimeKnown !== true) — unknown renderer/font/image metadata is diagnostic, not accepted');
  }
  // bijection — the SAME derived obligation contract as the publisher (every
  // captured route PNG + every declared `redirect_` redirect PNG + both
  // conditional captures), with strict identity / destination / content-sentinel
  // provenance checks. A navigation-only redirect proof is never accepted.
  for (const p of validateManifestCaptures({ obligations, captures: manifest.captures })) errors.push(p);
  for (const c of manifest.captures ?? []) {
    const file = path.join(ROOT, c.file);
    if (!existsSync(file)) {
      errors.push(`manifest references missing PNG: ${c.file}`);
      continue;
    }
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (sha !== c.sha256) errors.push(`sha256 mismatch for ${c.file}: manifest ${c.sha256} != disk ${sha}`);
    if (c.purpose !== 'regression-not-parity') errors.push(`capture ${c.project}::${c.file} purpose must be regression-not-parity`);
  }
}

// 3. LIVE router graph (round-13): re-derive the CURRENT graph READ-ONLY with
// the SAME AST producer that generated the committed inventory, and fail closed
// on any stale route / redirect / meaningful-parameter / obligation identity. A
// NEW reachable route with no committed inventory entry (and therefore no
// baseline) fails here. Generation timestamps and source LINE OFFSETS alone are
// ignored; reachable paths, redirect targets, declared (parameter) shapes and
// every unresolved obligation are preserved. The guard NEVER writes the
// inventory and NEVER mutates source to make it match.
{
  const { buildRouteGraphAsync } = await import('../lib/route-graph.mjs');
  const { cleanupContractTmp } = await import('../lib/contract.mjs');
  const normPath = (p) => (p == null ? '' : String(p).replace(/\/+$/, '') || '/');
  const stripLine = (s) => String(s ?? '').replace(/:\d+$/, ''); // ignore source line offsets
  const kindOf = (r) => (r.kind === 'redirect' || r.coverage === 'redirect-recorded' ? 'redirect' : r.kind === 'module-mount' ? 'module-mount' : r.kind === 'dynamic' ? 'dynamic' : 'page');

  let live = null;
  try {
    live = await buildRouteGraphAsync();
  } catch (e) {
    errors.push(`live route-graph derivation FAILED (cannot prove the committed inventory is current): ${e.message}`);
  } finally {
    try { cleanupContractTmp(); } catch { /* diagnostic temp only */ }
  }

  if (live) {
    const invByPath = new Map(inventory.routes.map((r) => [normPath(r.path), r]));
    const liveByPath = new Map(live.routes.map((r) => [normPath(r.path), r]));

    // 3a. NEW reachable route absent from the committed inventory (needs a
    // committed inventory + a baseline before it can be accepted).
    for (const [p, r] of liveByPath) {
      if (!invByPath.has(p)) errors.push(`live route '${p}' (${kindOf(r)}) is NOT in the committed inventory — a new/changed route requires a committed inventory + baseline`);
    }
    // 3b. STALE inventory route no longer reachable in the live graph.
    for (const [p, r] of invByPath) {
      if (!liveByPath.has(p)) errors.push(`committed inventory route '${p}' (${kindOf(r)}) is no longer reachable in the live router graph — stale inventory`);
    }
    // 3c. REDIRECT identities (path -> target) must match exactly.
    const invRedirects = new Map(inventory.routes.filter((r) => kindOf(r) === 'redirect').map((r) => [normPath(r.path), r.redirectTo ?? null]));
    const liveRedirects = new Map(live.routes.filter((r) => kindOf(r) === 'redirect').map((r) => [normPath(r.path), r.redirectTo ?? null]));
    for (const [p, to] of liveRedirects) {
      if (!invRedirects.has(p)) errors.push(`live redirect '${p}' is missing from the committed inventory`);
      else if ((invRedirects.get(p) ?? null) !== (to ?? null)) errors.push(`redirect target changed for '${p}': inventory '${invRedirects.get(p)}' vs live '${to}'`);
    }
    for (const [p] of invRedirects) if (!liveRedirects.has(p)) errors.push(`committed redirect '${p}' is no longer a redirect in the live graph`);
    // 3d. MEANINGFUL PARAMETER shape (declaredPath) identities must match: a
    // resolved concrete path is not enough — a changed `:param` name matters.
    const invDeclared = new Map(inventory.routes.map((r) => [normPath(r.declaredPath ?? r.path), kindOf(r)]));
    const liveDeclared = new Map(live.routes.map((r) => [normPath(r.declaredPath ?? r.path), kindOf(r)]));
    for (const [d, k] of liveDeclared) if (!invDeclared.has(d)) errors.push(`live declared path '${d}' (${k}) is missing from the committed inventory`);
    for (const [d] of invDeclared) if (!liveDeclared.has(d)) errors.push(`committed declared path '${d}' is no longer derived from source — stale inventory`);
    // 3e. EVERY unresolved obligation must be preserved (identity by
    // source+reason with line offsets ignored).
    const obligKey = (o) => `${stripLine(o.source)}|${o.reason}`;
    const invOblig = new Set((inventory.obligations ?? []).map(obligKey));
    const liveOblig = new Set((live.obligations ?? []).map(obligKey));
    for (const o of liveOblig) if (!invOblig.has(o)) errors.push(`live unresolved obligation missing from inventory: ${o}`);
    for (const o of invOblig) if (!liveOblig.has(o)) errors.push(`committed obligation no longer derived from source — stale inventory: ${o}`);
  }
}

console.log(`[guard] captured=${captured.length} redirects=${redirects.length} declaredRedirectPngs=${obligations.redirects.length} projects=${projects.length} expectedPngs=${obligations.counts.executableRoutePngs + obligations.counts.conditional}/project errors=${errors.length}`);
if (errors.length) {
  console.error('[guard] FAILED:');
  for (const e of errors) console.error(`  ! ${e}`);
  process.exit(1);
}
console.log('[guard] OK — route↔baseline bijection, hashes, policy and identity all valid.');
