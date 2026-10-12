#!/usr/bin/env node
/**
 * Generate apps/e2e/route-sentinels.json — the reviewable PER-ROUTE content
 * contract (round-4: a request count is not a sentinel).
 *
 * Each captured route gets an entry that pins:
 *   - `ownEndpoints`: the EXACT route-owned seeded endpoint pathname(s) this
 *     route must consume (outside the shared-shell set) — real fixture identity,
 *     not a count. Empty for a legitimate static page.
 *   - `staticOnly`: true when the route is a static surface (no API needed) that
 *     is proven by its OWN rendered content instead.
 *   - `headingRe` / `textRe`: the pinned visible content of the route.
 *   - `forbid`: absent / loading / handled-error markers that must NOT appear.
 *   - `shellFree` (optional): the route is a REAL renderer that intentionally
 *     runs OUTSIDE the vNext shell (the public planner form). The capture spec
 *     then skips ONLY the shell-root precondition — every content/own-endpoint
 *     assertion still applies. Never used to fabricate or bypass a shell.
 *   - `queryDefaults` (optional): requested query params the app legitimately
 *     canonicalizes AWAY on a same-pathname landing (e.g. a defaulted
 *     `period=current`). Every other requested param must survive.
 *
 * Reviewed redirect-DESTINATION content keys (overlay `routes` entries whose key
 * carries a query, e.g. `/explorer?bill=hr-2027-1234`) are a DISTINCT content
 * contract from the bare pathname: they are emitted into `routes` verbatim so
 * the exact-destination lookup resolves them, but they are NOT captured routes
 * and never inflate `capturedRoutes` / `pinnedData`. Such a key is emitted ONLY
 * when it is (a) an ACTUAL declared redirect destination and (b) carries
 * explicit own content — a malformed or unused destination key fails closed
 * instead of being silently ignored.
 *
 * Sources, in precedence order:
 *   1. `route-sentinels.overlay.json` — hand-REVIEWED pins (authoritative).
 *      The overlay also carries a `redirects` map that is the authoritative
 *      override for a route's recorded redirect destination (used to correct a
 *      stale recorded contract).
 *   2. `reports/route-content-observed.json` — content observed in a STRICT
 *      (zero-gap) discovery pass; used only to pin content that already rendered
 *      with no unseeded endpoint, so a loading/blank shell can never be pinned.
 *
 * A captured route with neither a reviewed pin nor observable zero-gap content
 * is left OUT of the file and listed in `unresolvedRoutes` — the capture spec
 * then fails closed for it (no generic fallback). Need stricter `headingRe`/
 * `textRe` per route as captures are reviewed; the generator never invents one.
 *
 *   node scripts/gen-route-sentinels.mjs --write
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_SHELL_ENDPOINTS, FORBIDDEN_STATE_MARKERS } from '../lib/projects.mjs';

const USAGE = 'Usage: node apps/e2e/scripts/gen-route-sentinels.mjs --write';
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(USAGE);
  process.exit(2);
}
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (args.length !== 1 || args[0] !== '--write') {
  console.error(USAGE);
  console.error(`[sentinels] unknown argument: ${args.join(' ')}`);
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.inventory.json'), 'utf8'));

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
const overlay = readJson(path.join(ROOT, 'route-sentinels.overlay.json')) ?? { routes: {} };
const observed = readJson(path.join(ROOT, 'route-content-observed.json')) ?? { routes: {} };
const unclean = readJson(path.join(ROOT, 'route-content-unclean.json')) ?? { routes: [] };

const pathOnly = (s) => (String(s).split('?')[0] || '/').replace(/\/$/, '') || '/';
/** Runtime redirect destination observed for a captured route, or null. */
const uncleanByRoute = new Map((unclean.routes ?? []).map((u) => [u.route, u]));
function observedRedirect(pathname) {
  const u = uncleanByRoute.get(pathname);
  if (!u || !u.landed) return null;
  return pathOnly(u.landed) !== pathOnly(pathname) ? u.landed : null;
}

const SHARED = new Set(SHARED_SHELL_ENDPOINTS);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** pathname of a recorded "GET /x?y" / "get /x" endpoint, query stripped. */
function barePath(entry) {
  const u = String(entry).replace(/^[A-Za-z]+ /, '');
  return u.split('?')[0] || u;
}
function ownEndpointsFrom(obs) {
  if (!obs || !Array.isArray(obs.seeded)) return [];
  const all = [...new Set(obs.seeded.map(barePath))];
  return all.filter((p) => !SHARED.has(p));
}

const routes = {};
const redirects = {};
const sentinelsRedirectsSeen = new Set();
const unresolved = [];
let pinnedData = 0;
let pinnedStatic = 0;

// Reviewed redirect overrides (authoritative). Used to correct a recorded
// destination that drifted from the current implementation (e.g. the
// /intelligence/bills -> Explorer fallback no longer appends `source=bills`).
const overlayRedirects = (overlay && typeof overlay.redirects === 'object' && overlay.redirects) || {};

/** Attach the optional round-21 contract fields when the overlay pins them. */
function withOptional(e, ov) {
  if (ov.shellFree === true) e.shellFree = true;
  if (ov.queryDefaults !== undefined) {
    if (!ov.queryDefaults || Array.isArray(ov.queryDefaults) || typeof ov.queryDefaults !== 'object' ||
        Object.entries(ov.queryDefaults).some(([key, value]) => !key || typeof value !== 'string')) {
      throw new Error('queryDefaults must map exact parameter names to exact default string values');
    }
    e.queryDefaults = { ...ov.queryDefaults };
  }
  return e;
}

for (const r of inventory.routes) {
  if (r.coverage !== 'captured') {
    const dest = overlayRedirects[r.path] ?? r.redirectTo;
    if ((r.coverage === 'redirect-recorded' || r.kind === 'redirect') && dest) redirects[r.path] = dest;
    continue;
  }
  const ov = (overlay.routes ?? {})[r.path] ?? {};
  const obs = (observed.routes ?? {})[r.path];

  // A REVIEWED redirect override wins over a runtime observation, and a captured
  // route observed to redirect at runtime is recorded as an explicit redirect
  // (destination from the actual navigation), never a page baseline.
  const ovRedirect = overlayRedirects[r.path];
  const redirectTo = ovRedirect ?? observedRedirect(r.path);
  if (redirectTo) {
    if (!sentinelsRedirectsSeen.has(r.path)) { redirects[r.path] = redirectTo; sentinelsRedirectsSeen.add(r.path); }
    continue;
  }

  const own = Array.isArray(ov.ownEndpoints) ? [...ov.ownEndpoints] : ownEndpointsFrom(obs);
  const observedHeading = obs && Array.isArray(obs.headings) ? obs.headings.find((h) => typeof h === 'string' && h.trim().length >= 2) : undefined;
  const headingRe = ov.headingRe ?? (observedHeading ? esc(observedHeading.trim()) : undefined);
  const textRe = ov.textRe;

  // No route-owned endpoint observed: this is only acceptable for a STATIC page
  // with an explicit REVIEWED pin (overlay staticOnly + headingRe/textRe). It is
  // never auto-marked static from an observation, so a degraded/blank render can
  // never be pinned as "static content".
  if (own.length === 0) {
    if (ov.staticOnly === true && (ov.headingRe || ov.textRe)) {
      const e = withOptional({ ownEndpoints: [], staticOnly: true, forbid: ov.forbid ?? [...FORBIDDEN_STATE_MARKERS], minBodyChars: ov.minBodyChars ?? 40 }, ov);
      if (ov.headingRe) e.headingRe = ov.headingRe;
      if (ov.textRe) e.textRe = ov.textRe;
      routes[r.path] = e;
      pinnedStatic++;
    } else {
      unresolved.push(r.path);
    }
    continue;
  }

  const entry = withOptional({
    ownEndpoints: own,
    staticOnly: false,
    forbid: ov.forbid ?? [...FORBIDDEN_STATE_MARKERS],
    minBodyChars: ov.minBodyChars ?? 40,
  }, ov);
  if (headingRe) entry.headingRe = headingRe;
  if (textRe) entry.textRe = textRe;
  routes[r.path] = entry;
  pinnedData++;
}

// ── Exact reviewed redirect-DESTINATION content keys ────────────────────────
// A redirect destination that carries a MEANINGFUL query (e.g.
// `/explorer?bill=hr-2027-1234`) is a DISTINCT destination content contract from
// its bare pathname (plain `/explorer` renders the articles tab). Such a key
// lives in the overlay's `routes` map but is NOT an inventory route, so the
// inventory loop above ignores it. Emit it here, bounded to keys that are (a) an
// ACTUAL declared redirect destination and (b) carry explicit own content, so a
// malformed or unused destination key FAILS CLOSED instead of being silently
// dropped. It never inflates capturedRoutes / pinnedData (no fabricated route or
// snapshot identity) and never weakens the bare pathname's own sentinel.
const declaredDestinations = new Set(
  Object.values(redirects).filter((d) => typeof d === 'string' && d.startsWith('/')),
);
const destinationKeys = new Set();
const destinationProblems = [];
for (const key of Object.keys(overlay.routes ?? {})) {
  if (!String(key).includes('?')) continue; // query-bearing destination keys only
  // A key ALREADY generated as a captured route (e.g. an inventory route whose
  // own path carries a query, like /engagement/reports?period=current) is NOT a
  // redirect-destination key: keep its existing full contract/counts and skip
  // the destination-only validation below. Only genuinely EXTRA query keys are
  // held to the exact declared-destination requirement.
  if (Object.prototype.hasOwnProperty.call(routes, key)) continue;
  const ov = overlay.routes[key];
  if (!declaredDestinations.has(key)) {
    destinationProblems.push(`overlay destination key '${key}' is not a declared redirect destination (unused key)`);
    continue;
  }
  if (!ov || typeof ov !== 'object') {
    destinationProblems.push(`overlay destination key '${key}' has no content contract object`);
    continue;
  }
  const own = Array.isArray(ov.ownEndpoints) ? [...ov.ownEndpoints] : [];
  const staticOk = ov.staticOnly === true && Boolean(ov.headingRe || ov.textRe);
  if (own.length === 0 && !staticOk) {
    destinationProblems.push(`overlay destination key '${key}' pins neither ownEndpoints nor static headingRe/textRe (fail-closed)`);
    continue;
  }
  const e = withOptional({
    ownEndpoints: own,
    staticOnly: own.length === 0,
    forbid: ov.forbid ?? [...FORBIDDEN_STATE_MARKERS],
    minBodyChars: ov.minBodyChars ?? 40,
  }, ov);
  if (ov.headingRe) e.headingRe = ov.headingRe;
  if (ov.textRe) e.textRe = ov.textRe;
  routes[key] = e;
  destinationKeys.add(key);
}

const out = {
  schema: 'capiro.cleanup1.route-sentinels.v2',
  note:
    'Per-route content contracts (fail-closed). ownEndpoints = exact route-owned seeded endpoint(s) that MUST ' +
    'be consumed outside the shared-shell set (real fixture identity, not a request count). staticOnly routes are ' +
    'proven by their own rendered content with no artificial API call. headingRe/textRe pin visible content; forbid ' +
    'blocks absent/loading/error states. shellFree (public planner form) skips ONLY the shell-root precondition; ' +
    'queryDefaults lists requested params the app legitimately canonicalizes away on a same-pathname landing. ' +
    'Generated by scripts/gen-route-sentinels.mjs; review and tighten per route.',
  capturedRoutes: Object.keys(routes).length - destinationKeys.size,
  redirectRoutes: Object.keys(redirects).length,
  pinnedData,
  pinnedStatic,
  destinationContracts: destinationKeys.size,
  unresolvedRoutes: unresolved,
  routes,
  redirects,
};
const dest = path.join(ROOT, 'route-sentinels.json');
fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(
  `[sentinels] captured=${Object.keys(routes).length - destinationKeys.size} redirects=${Object.keys(redirects).length} ` +
    `pinnedData=${pinnedData} pinnedStatic=${pinnedStatic} destinationKeys=${destinationKeys.size} unresolved=${unresolved.length} -> ${path.relative(ROOT, dest)}`,
);
if (unresolved.length) {
  console.error('[sentinels] UNRESOLVED (fail-closed, no generic fallback):');
  for (const p of unresolved) console.error(`  ! ${p}`);
  process.exitCode = 2;
}
if (destinationProblems.length) {
  console.error('[sentinels] DESTINATION KEY PROBLEMS (fail-closed, no silent drop):');
  for (const p of destinationProblems) console.error(`  ! ${p}`);
  process.exitCode = 2;
}
