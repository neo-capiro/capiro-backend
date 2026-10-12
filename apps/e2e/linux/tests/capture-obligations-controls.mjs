#!/usr/bin/env node
/**
 * Bounded capture-obligation controls (CleanUp1 §8.3/§8.4/§8.5).
 *
 * Drives the REAL shared helper (apps/e2e/lib/capture-obligations.mjs) that BOTH
 * scripts/capture-baselines.mjs (publisher) and scripts/guard-route-coverage.mjs
 * (guard) consume, plus a bounded SOURCE-shape check over the two specs and the
 * guard. These are SOURCE-ONLY models of the contract — they are NOT native
 * acceptance and never substitute for the real capture/publication/guard runs
 * that root performs.
 *
 *   node apps/e2e/linux/tests/capture-obligations-controls.mjs
 * Exit: 0 all controls pass; 1 any failed.
 *
 * Covered, derived from the ACTUAL committed inventory / sentinel / project
 * contracts (never hard-coded acceptance):
 *   - 122-entry inventory → 105 captured + 9 declared redirects + 8 module nodes;
 *   - the 20 sentinel redirect relationships, ALL 20 binding an EXACT reviewed
 *     destination key (the bill deep-link /explorer?bill=… has its OWN
 *     bill-destination contract and never falls back to plain /explorer);
 *   - 114 executable route PNGs + 2 conditional per project (116; 348 total);
 *   - intended captured-route filename preservation (underscore, NOT hyphen);
 *   - declared-redirect wildcard namespace + collision refusal;
 *   - array screenshot arguments in both specs;
 *   - missing / duplicate / orphan / malformed / colliding inputs and
 *     inconsistent destinations / unsupported content contracts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveCaptureObligations,
  expectedCaptures,
  validateManifestCaptures,
  routeSlug,
  capturedRouteFilename,
  declaredRedirectFilename,
  sentinelKeyForDestination,
  REDIRECT_FILENAME_PREFIX,
} from '../../lib/capture-obligations.mjs';
import { PROJECTS } from '../../lib/projects.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..'); // apps/e2e

let failures = 0;
function control(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r === true || (r && r.ok === true);
    if (r && typeof r === 'object' && r.detail) detail = r.detail;
  } catch (e) {
    detail = `threw: ${e.message}`;
  }
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const rawInventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.inventory.json'), 'utf8'));
const rawSentinels = JSON.parse(fs.readFileSync(path.join(ROOT, 'route-sentinels.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── A. the ACTUAL committed contract ────────────────────────────────────────
const real = deriveCaptureObligations({ inventory: rawInventory, sentinels: rawSentinels });

control('the real inventory/sentinel contracts derive WITHOUT problems', () => ({
  ok: real.ok === true,
  detail: real.problems.join('; '),
}));

control('inventory has 122 routes / 105 captured / 9 declared redirects / 8 module nodes', () => {
  const total = rawInventory.routes.length;
  const moduleNodes = rawInventory.routes.filter((r) => r.coverage === 'module-resolved').length;
  return {
    ok: total === 122 && real.counts.captured === 105 && rawInventory.routes.filter((r) => r.coverage === 'redirect-recorded').length === 9 && moduleNodes === 8,
    detail: `total=${total} captured=${real.counts.captured} declared=${real.counts.declaredRedirects} module=${moduleNodes}`,
  };
});

control('11 captured routes are runtime redirects (sentinel-declared)', () => ({
  ok: real.counts.capturedRedirects === 11,
  detail: `capturedRedirects=${real.counts.capturedRedirects}`,
}));

control('114 executable route PNGs + 2 conditional per project → 116/project, 348 total', () => {
  const perProject = real.counts.executableRoutePngs + real.counts.conditional;
  const total = perProject * real.counts.projects;
  return {
    ok: real.counts.executableRoutePngs === 114 && real.counts.conditional === 2 && real.counts.projects === 3 && perProject === 116 && total === 348,
    detail: `routes=${real.counts.executableRoutePngs} conditional=${real.counts.conditional} perProject=${perProject} total=${total}`,
  };
});

control('all 20 redirect destinations resolve an EXACT content sentinel (no pathname fallback)', () => {
  const redirectEntries = [...real.routes.filter((r) => r.kind === 'redirect'), ...real.redirects];
  const dests = redirectEntries.map((r) => r.redirectTo);
  const routeKeys = rawSentinels.routes ?? {};
  const exact = dests.filter((d) => Object.prototype.hasOwnProperty.call(routeKeys, d));
  const pathnameOnly = dests.filter((d) => !Object.prototype.hasOwnProperty.call(routeKeys, d));
  const unresolved = redirectEntries.filter((r) => !r.sentinelKey).length;
  return {
    ok: dests.length === 20 && exact.length === 20 && pathnameOnly.length === 0 && unresolved === 0,
    detail: `entries=${dests.length} exact=${exact.length} pathnameOnly=${JSON.stringify(pathnameOnly)} unresolved=${unresolved}`,
  };
});

control('the /explorer?bill=… redirect binds its OWN exact bill-destination sentinel (not plain /explorer)', () => {
  const entry = real.routes.find((r) => r.redirectTo === '/explorer?bill=hr-2027-1234');
  const key = sentinelKeyForDestination(rawSentinels, '/explorer?bill=hr-2027-1234');
  return {
    ok:
      Boolean(entry) &&
      key === '/explorer?bill=hr-2027-1234' &&
      entry.sentinelKey === '/explorer?bill=hr-2027-1234' &&
      entry.sentinelKey !== '/explorer',
    detail: `key=${key} sentinelKey=${entry && entry.sentinelKey}`,
  };
});

control('the bill destination pins the REAL bill list/facets/detail endpoints and bill-specific content', () => {
  const e = rawSentinels.routes?.['/explorer?bill=hr-2027-1234'];
  const want = ['/api/explorer/bill-facets', '/api/explorer/congress-bills', '/api/explorer/congress-bills/hr-2027-1234'];
  const article = ['/api/explorer/intel-article-facets', '/api/explorer/intel-articles'];
  const own = e && Array.isArray(e.ownEndpoints) ? e.ownEndpoints : [];
  // The heading is a source-textContent pin, but textRe is tested against the
  // RENDERED body.innerText: explorer.css:716-725 `text-transform:uppercase`
  // makes the DrillSection h3 title visible as RECENT ACTIONS, so the visible
  // content regex must pin the uppercase label AND, in order, the real seeded
  // visible action sentence from the BillDetail fixture (routes-visual-api.ts
  // EXPLORER_BILL_DETAIL.actions[0].text / latestActionText).
  const re = e && typeof e.textRe === 'string' ? new RegExp(e.textRe) : null;
  const visible = 'RECENT ACTIONS\nJun 17, 2026\nReferred to the Committee on Appropriations.\nHouse';
  const wrongCase = 'Recent actions\nReferred to the Committee on Appropriations.';
  return {
    ok:
      Boolean(e) && e.staticOnly === false &&
      want.every((w) => own.includes(w)) &&
      article.every((a) => !own.includes(a)) &&
      e.headingRe === 'Congress Bills · hr-2027-1234' &&
      Boolean(re) && re.test(visible) && !re.test(wrongCase) && !/i|g/.test(re.flags) &&
      Array.isArray(e.forbid) && e.forbid.length > 0,
    detail: `own=${JSON.stringify(own)} headingRe=${e && e.headingRe} textRe=${e && e.textRe} flags=${re && re.flags}`,
  };
});

control('the bill destination textRe FAILS a shell/uppercase label carrying NO action data', () => {
  const e = rawSentinels.routes?.['/explorer?bill=hr-2027-1234'];
  const re = e && typeof e.textRe === 'string' ? new RegExp(e.textRe) : null;
  const shellOnly = 'RECENT ACTIONS\nJun 17, 2026';
  return {
    ok: Boolean(re) && re.test('RECENT ACTIONS\nReferred to the Committee on Appropriations.') && !re.test(shellOnly),
    detail: `textRe=${e && e.textRe}`,
  };
});

control('the bill destination textRe FAILS a wrong-case label (pins the ACTUAL uppercase visible text, case-sensitively)', () => {
  const e = rawSentinels.routes?.['/explorer?bill=hr-2027-1234'];
  const re = e && typeof e.textRe === 'string' ? new RegExp(e.textRe) : null;
  return {
    ok:
      Boolean(re) && e.textRe.startsWith('RECENT ACTIONS') && e.textRe.endsWith('Appropriations\\.') &&
      !re.test('Recent actions\nReferred to the Committee on Appropriations.') &&
      !/i|g/.test(re.flags),
    detail: `textRe=${e && e.textRe} flags=${re && re.flags}`,
  };
});

control('the plain /explorer sentinel keeps its article endpoints (unchanged by the bill contract)', () => {
  const e = rawSentinels.routes?.['/explorer'];
  const own = e && Array.isArray(e.ownEndpoints) ? e.ownEndpoints : [];
  return {
    ok:
      Boolean(e) && e.staticOnly === false &&
      own.length === 2 &&
      own.includes('/api/explorer/intel-article-facets') &&
      own.includes('/api/explorer/intel-articles') &&
      e.headingRe === 'Intelligence Center',
    detail: `own=${JSON.stringify(own)} headingRe=${e && e.headingRe}`,
  };
});

control('removing the exact bill-destination key FAILS CLOSED (never falls back to plain /explorer)', () => {
  const s = clone(rawSentinels);
  delete s.routes['/explorer?bill=hr-2027-1234'];
  const key = sentinelKeyForDestination(s, '/explorer?bill=hr-2027-1234');
  const r = deriveCaptureObligations({ inventory: clone(rawInventory), sentinels: s });
  return {
    ok:
      key === null &&
      r.ok === false &&
      r.problems.some((p) => /destination \/explorer\?bill=hr-2027-1234 has no content sentinel/.test(p)),
    detail: `key=${key} ok=${r.ok} ${r.problems.slice(0, 2).join('; ')}`,
  };
});

control('an UNKNOWN query-bearing redirect destination FAILS CLOSED (no unrelated default content)', () => {
  const s = clone(rawSentinels);
  s.redirects['/intelligence/bills/hr-2027-1234'] = '/explorer?bill=does-not-exist';
  const key = sentinelKeyForDestination(s, '/explorer?bill=does-not-exist');
  const r = deriveCaptureObligations({ inventory: clone(rawInventory), sentinels: s });
  return {
    ok:
      key === null &&
      r.ok === false &&
      r.problems.some((p) => /destination \/explorer\?bill=does-not-exist has no content sentinel/.test(p)),
    detail: `key=${key} ok=${r.ok}`,
  };
});

control('an exact destination key binds; an unknown query-bearing or trailing-slash variant fails closed (null)', () => {
  const synthetic = { routes: { '/safe': { ownEndpoints: ['/api/x'], staticOnly: false, forbid: ['x'] } } };
  const exact = sentinelKeyForDestination(synthetic, '/safe');
  const query = sentinelKeyForDestination(synthetic, '/safe?tab=1');
  const slash = sentinelKeyForDestination(synthetic, '/safe/');
  return { ok: exact === '/safe' && query === null && slash === null, detail: `exact=${exact} query=${query} slash=${slash}` };
});

control('intended captured-route filenames are preserved (underscore, NOT hyphen-sanitized)', () => {
  const a = capturedRouteFilename('/');
  const b = capturedRouteFilename('/directory/districts/VA/08');
  const c = capturedRouteFilename('/engagement/reports?period=current');
  return {
    ok: a === 'root.png' && b === 'directory_districts_VA_08.png' && c === 'engagement_reports_period_current.png' && !b.includes('-') && !c.includes('-'),
    detail: `${a}, ${b}, ${c}`,
  };
});

control('declared /legiwatch/* uses the redirect_ namespace and does NOT collide with captured /legiwatch', () => {
  const declaredWildcard = declaredRedirectFilename('/legiwatch/*');
  const capturedLegi = capturedRouteFilename('/legiwatch');
  const declared = real.redirects.find((r) => r.path === '/legiwatch/*');
  return {
    ok:
      declaredWildcard === `${REDIRECT_FILENAME_PREFIX}legiwatch.png` &&
      capturedLegi === 'legiwatch.png' &&
      declaredWildcard !== capturedLegi &&
      Boolean(declared) &&
      declared.sentinelKey === '/legiwatch?tab=hearings' &&
      real.ok === true,
    detail: `declared=${declaredWildcard} captured=${capturedLegi} dest=${declared && declared.redirectTo}`,
  };
});

control('every expected per-project capture filename is unique (no bijection collision)', () => {
  const files = expectedCaptures(real).filter((e) => e.project === 'desktop-1440').map((e) => e.filename);
  const unique = new Set(files);
  return { ok: files.length === 116 && unique.size === files.length, detail: `files=${files.length} unique=${unique.size}` };
});

// ── B. array-name source controls (the exact harness fix) ────────────────────
control('both specs pass ARRAY screenshot names (not sanitized strings)', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'tests', 'routes.spec.ts'), 'utf8');
  const cond = fs.readFileSync(path.join(ROOT, 'tests', 'conditional.spec.ts'), 'utf8');
  const total = (spec.match(/toHaveScreenshot\(/g) || []).length + (cond.match(/toHaveScreenshot\(/g) || []).length;
  const arrays = (spec.match(/toHaveScreenshot\(\[/g) || []).length + (cond.match(/toHaveScreenshot\(\[/g) || []).length;
  return { ok: total > 0 && total === arrays, detail: `total=${total} array=${arrays}` };
});

control('the guard / publisher share the derived obligation contract', () => {
  const guard = fs.readFileSync(path.join(ROOT, 'scripts', 'guard-route-coverage.mjs'), 'utf8');
  const pub = fs.readFileSync(path.join(ROOT, 'scripts', 'capture-baselines.mjs'), 'utf8');
  return {
    ok:
      guard.includes('deriveCaptureObligations') && guard.includes('validateManifestCaptures') &&
      pub.includes('deriveCaptureObligations'),
  };
});

control('the guard RETAINS the live new-route / stale / redirect-target / obligation checks', () => {
  const guard = fs.readFileSync(path.join(ROOT, 'scripts', 'guard-route-coverage.mjs'), 'utf8');
  return {
    ok:
      guard.includes('is NOT in the committed inventory') &&
      guard.includes('no longer reachable in the live router graph') &&
      guard.includes('redirect target changed for') &&
      guard.includes('live declared path') &&
      guard.includes('live unresolved obligation missing from inventory') &&
      guard.includes('buildRouteGraphAsync'),
  };
});

// ── C. malformed / duplicate / colliding input refusal ───────────────────────
const withInv = (mut) => { const inv = clone(rawInventory); mut(inv); return deriveCaptureObligations({ inventory: inv, sentinels: clone(rawSentinels) }); };
const withSent = (mut) => { const s = clone(rawSentinels); mut(s); return deriveCaptureObligations({ inventory: clone(rawInventory), sentinels: s }); };

control('a DUPLICATE inventory route path is rejected', () => {
  const r = withInv((inv) => inv.routes.push({ path: '/actions', coverage: 'captured' }));
  return { ok: r.problems.some((p) => /duplicate inventory route path/.test(p)) };
});
control('a MALFORMED inventory route path is rejected', () => {
  const r = withInv((inv) => inv.routes.push({ path: 'actions', coverage: 'captured' }));
  return { ok: r.problems.some((p) => /malformed inventory route/.test(p)) };
});
control('a captured route with NO sentinel entry is rejected (no generic fallback)', () => {
  const r = withSent((s) => { delete s.routes['/actions']; });
  return { ok: r.problems.some((p) => /captured route \/actions has no sentinel entry/.test(p)) };
});
control('an INCONSISTENT declared redirect destination is rejected', () => {
  const r = withInv((inv) => { inv.routes.find((x) => x.path === '/admin').redirectTo = '/settings/nowhere'; });
  return { ok: r.problems.some((p) => /inconsistent redirect destination for \/admin/.test(p)) };
});
control('a captured redirect destination with NO content sentinel is rejected', () => {
  const r = withSent((s) => { s.redirects['/portfolio'] = '/nowhere-xyz'; });
  return { ok: r.problems.some((p) => /destination \/nowhere-xyz has no content sentinel/.test(p)) };
});
control('an UNSUPPORTED destination content contract is rejected', () => {
  const r = withSent((s) => { s.routes['/settings/team'] = { ownEndpoints: [], staticOnly: false, forbid: ['x'] }; });
  return { ok: r.problems.some((p) => /neither data-pinned/.test(p)) };
});
control('a FILENAME COLLISION across the redirect namespace is refused', () => {
  // A captured route whose slug starts with redirect_ collides with a declared one.
  const r = withSent((s) => { s.routes['/redirect_admin'] = { ownEndpoints: ['/api/x'], staticOnly: false, forbid: ['x'] }; });
  const r2 = (() => {
    const inv = clone(rawInventory);
    inv.routes.push({ path: '/redirect_admin', coverage: 'captured' });
    return deriveCaptureObligations({ inventory: inv, sentinels: clone(rawSentinels) });
  })();
  return { ok: r2.problems.some((p) => /filename collision/.test(p)), detail: r.problems.concat(r2.problems).slice(0, 2).join('; ') };
});

// ── D. manifest capture-set validation (shared with the guard) ───────────────
const realExpected = expectedCaptures(real).map((e) => ({ ...e, sha256: 'deadbeef', bytes: 1, purpose: 'regression-not-parity' }));
const findBy = (kind, pred) => realExpected.find((e) => e.kind === kind && pred(e));

control('a faithful capture set validates with NO problems', () => {
  const problems = validateManifestCaptures({ obligations: real, captures: realExpected });
  return { ok: problems.length === 0, detail: problems.slice(0, 3).join('; ') };
});
control('a MISSING ordinary route capture is rejected', () => {
  const caps = realExpected.filter((e) => e.filename !== 'actions.png');
  return { ok: validateManifestCaptures({ obligations: real, captures: caps }).some((p) => /missing baseline capture for route/.test(p) && /actions\.png/.test(p)) };
});
control('a MISSING declared redirect capture is rejected', () => {
  const caps = realExpected.filter((e) => e.filename !== 'redirect_admin.png');
  return { ok: validateManifestCaptures({ obligations: real, captures: caps }).some((p) => /missing baseline capture for redirect/.test(p) && /redirect_admin\.png/.test(p)) };
});
control('a MISSING conditional capture is rejected', () => {
  const caps = realExpected.filter((e) => e.filename !== 'conditional_bills_bill360_enabled.png');
  return { ok: validateManifestCaptures({ obligations: real, captures: caps }).some((p) => /missing baseline capture for conditional/.test(p)) };
});
control('a DUPLICATE capture is rejected', () => {
  const caps = [...realExpected, findBy('route', (e) => e.filename === 'actions.png')];
  return { ok: validateManifestCaptures({ obligations: real, captures: caps }).some((p) => /duplicate manifest capture/.test(p)) };
});
control('an ORPHAN capture (unknown filename) is rejected', () => {
  const caps = [...realExpected, { project: 'desktop-1440', kind: 'route', route: '/nope', filename: 'nope.png', file: 'baselines/desktop-1440/nope.png', sha256: 'x', bytes: 1, purpose: 'regression-not-parity' }];
  return { ok: validateManifestCaptures({ obligations: real, captures: caps }).some((p) => /orphan baseline capture/.test(p)) };
});
control('a WRONG-PROJECT capture is rejected', () => {
  const caps = realExpected.map((e) => (e.filename === 'actions.png' ? { ...e, project: 'tablet-1024' } : e));
  return { ok: validateManifestCaptures({ obligations: real, captures: caps }).some((p) => /project mismatch/.test(p)) };
});
control('a WRONG destination on a redirect capture is rejected', () => {
  const caps = realExpected.map((e) => (e.filename === 'redirect_admin.png' ? { ...e, redirectTo: '/settings/wrong' } : e));
  return { ok: validateManifestCaptures({ obligations: real, captures: caps }).some((p) => /destination must be/.test(p)) };
});
control('a WRONG content-sentinel provenance on a redirect capture is rejected', () => {
  const caps = realExpected.map((e) => (e.filename === 'redirect_admin.png' ? { ...e, sentinelKey: '/explorer' } : e));
  return { ok: validateManifestCaptures({ obligations: real, captures: caps }).some((p) => /content-sentinel provenance must be/.test(p)) };
});
control('a WRONG kind on a declared redirect capture is rejected', () => {
  const caps = realExpected.map((e) => (e.filename === 'redirect_admin.png' ? { ...e, kind: 'route' } : e));
  return { ok: validateManifestCaptures({ obligations: real, captures: caps }).some((p) => /kind must be 'redirect'/.test(p)) };
});
control('the routeSlug helper preserves the existing captured-route identity', () => ({
  ok: routeSlug('/') === 'root' && routeSlug('/directory/districts/VA/08') === 'directory_districts_VA_08',
}));

// ── E. reproduced-bug + contract-shape controls (REAL helper) ────────────────
// Every control below drives the actual deriveCaptureObligations /
// expectedCaptures / validateManifestCaptures helper over mutated clones of the
// REAL committed contracts, reproducing the three root-observed counterexamples.

// E1 — supported classification contract (positive).
control('the real inventory carries ONLY the four supported (coverage,kind) combinations', () => {
  const combos = {};
  for (const r of rawInventory.routes) {
    const k = `${r.coverage}/${r.kind}`;
    combos[k] = (combos[k] || 0) + 1;
  }
  return {
    ok:
      real.ok === true &&
      combos['captured/page'] === 99 &&
      combos['captured/dynamic'] === 6 &&
      combos['module-resolved/module-mount'] === 8 &&
      combos['redirect-recorded/redirect'] === 9 &&
      Object.keys(combos).length === 4,
    detail: JSON.stringify(combos),
  };
});

// E2 — counterexample 1: unknown coverage must not silently reduce obligations.
control('an UNKNOWN coverage classification is rejected (never silently drops obligations)', () => {
  const r = withInv((inv) => { inv.routes.find((x) => x.path === '/actions').coverage = 'unknown'; });
  return {
    ok: r.ok === false && r.problems.some((p) => /unsupported inventory coverage classification/.test(p)),
    detail: `ok=${r.ok} captured=${r.counts.captured} ${r.problems.slice(0, 2).join('; ')}`,
  };
});
control('a MALFORMED / missing coverage classification is rejected', () => {
  const r = withInv((inv) => { delete inv.routes.find((x) => x.path === '/actions').coverage; });
  return { ok: r.ok === false && r.problems.some((p) => /unsupported inventory coverage classification/.test(p)) };
});
control('a concrete page reassigned to a module exemption is rejected', () => {
  const r = withInv((inv) => { inv.routes.find((x) => x.path === '/actions').coverage = 'module-resolved'; });
  return {
    ok: r.ok === false && r.problems.some((p) => /inconsistent with kind/.test(p)) && r.problems.some((p) => /not a module-mount wildcard/.test(p)),
    detail: r.problems.slice(0, 2).join('; '),
  };
});
control('a module-mount node relabelled captured is rejected (no fabricated wildcard PNG)', () => {
  const r = withInv((inv) => { inv.routes.find((x) => x.path === '/engagement/*').coverage = 'captured'; });
  return { ok: r.ok === false && r.problems.some((p) => /inconsistent with kind/.test(p)), detail: r.problems.slice(0, 2).join('; ') };
});
control('a NEW valid executable route adds its PNG obligation and must be captured', () => {
  const inv = clone(rawInventory);
  inv.routes.push({ id: 'app:/brand-new-route', path: '/brand-new-route', declaredPath: 'path=/brand-new-route', kind: 'page', coverage: 'captured', redirectTo: null, surface: 'authenticated', vnextOverride: true });
  const s = clone(rawSentinels);
  s.routes['/brand-new-route'] = { ownEndpoints: ['/api/brand-new-route'], staticOnly: false, forbid: ['Loading…'], minBodyChars: 40 };
  const r = deriveCaptureObligations({ inventory: inv, sentinels: s });
  const expected = expectedCaptures(r).map((e) => ({ ...e, sha256: 'x', bytes: 1, purpose: 'regression-not-parity' }));
  const hasPng = expected.some((e) => e.filename === 'brand_new_route.png');
  const without = expected.filter((e) => e.filename !== 'brand_new_route.png');
  const manifestProblems = validateManifestCaptures({ obligations: r, captures: without });
  return {
    ok:
      r.ok === true && r.counts.captured === 106 && hasPng &&
      manifestProblems.some((p) => /missing baseline capture/.test(p) && /brand_new_route\.png/.test(p)),
    detail: `ok=${r.ok} captured=${r.counts.captured} png=${hasPng} ${r.problems.slice(0, 2).join('; ')}`,
  };
});

// E3 — counterexample 2: orphan / malformed / non-executable / missing redirect relationships.
control('a redirect-map relationship to a path NOT in the inventory is rejected', () => {
  const r = withSent((s) => { s.redirects['/orphan-not-in-inventory'] = '/actions'; });
  return { ok: r.ok === false && r.problems.some((p) => /orphan redirect-map relationship/.test(p) && /orphan-not-in-inventory/.test(p)), detail: r.problems.slice(0, 2).join('; ') };
});
control('a MALFORMED redirect-map destination is rejected', () => {
  const r = withSent((s) => { s.redirects['/portfolio'] = 'not-a-path'; });
  return { ok: r.ok === false && r.problems.some((p) => /malformed redirect-map destination for \/portfolio/.test(p)), detail: r.problems.slice(0, 3).join('; ') };
});
control('a redirect-map relationship to a module-mount (non-executable) path is rejected', () => {
  const r = withSent((s) => { s.redirects['/engagement/*'] = '/legiwatch'; });
  return { ok: r.ok === false && r.problems.some((p) => /orphan redirect-map relationship/.test(p) && /\/engagement\/\*/.test(p)), detail: r.problems.slice(0, 2).join('; ') };
});
control('a MISSING required declared-redirect mapping is rejected (no fallback)', () => {
  const r = withSent((s) => { delete s.redirects['/admin']; });
  return { ok: r.ok === false && r.problems.some((p) => /declared redirect \/admin has no required sentinels\.redirects mapping/.test(p)), detail: r.problems.slice(0, 2).join('; ') };
});
control('the real 20 redirect relationships all bind a live path to an explicit destination', () => {
  const keys = Object.keys(rawSentinels.redirects ?? {});
  const paths = new Set(rawInventory.routes.map((r) => r.path));
  return {
    ok: keys.length === 20 && keys.every((k) => paths.has(k)) && keys.every((k) => typeof rawSentinels.redirects[k] === 'string' && rawSentinels.redirects[k].startsWith('/')),
    detail: `keys=${keys.length}`,
  };
});

// E4 — counterexample 3: inventory viewport/project identity + dimensions.
control('the real inventory viewports match the shared PROJECTS contract', () => {
  return {
    ok:
      real.ok === true && real.counts.projects === 3 &&
      rawInventory.viewports.length === PROJECTS.length &&
      rawInventory.viewports.every((v) => PROJECTS.some((p) => p.name === v.name && p.viewport.width === v.width && p.viewport.height === v.height)),
    detail: JSON.stringify(rawInventory.viewports),
  };
});
control('a DUPLICATE inventory viewport is rejected (no duplicate project identities)', () => {
  const r = withInv((inv) => { inv.viewports.push(clone(inv.viewports[0])); });
  return { ok: r.ok === false && r.problems.some((p) => /duplicate inventory viewport name/.test(p)), detail: r.problems.slice(0, 2).join('; ') };
});
control('an EXTRA viewport not in the shared PROJECTS contract is rejected', () => {
  const r = withInv((inv) => { inv.viewports.push({ name: 'watch-5000', width: 5000, height: 5000 }); });
  return { ok: r.ok === false && r.problems.some((p) => /not declared in the shared PROJECTS contract/.test(p) && /watch-5000/.test(p)), detail: r.problems.slice(0, 2).join('; ') };
});
control('a MISSING PROJECTS viewport is rejected', () => {
  const r = withInv((inv) => { inv.viewports = inv.viewports.filter((v) => v.name !== 'mobile-390'); });
  return { ok: r.ok === false && r.problems.some((p) => /PROJECTS viewport 'mobile-390' is missing/.test(p)), detail: r.problems.slice(0, 2).join('; ') };
});
control('a WRONG-DIMENSION viewport is rejected', () => {
  const r = withInv((inv) => { inv.viewports.find((v) => v.name === 'tablet-1024').width = 1280; });
  return { ok: r.ok === false && r.problems.some((p) => /dimensions 1280x1000 do not match the PROJECTS contract 1024x1000/.test(p)), detail: r.problems.slice(0, 2).join('; ') };
});
control('a MALFORMED inventory viewport entry is rejected (never filtered away)', () => {
  const r = withInv((inv) => { inv.viewports.push({ name: 'broken', width: 'wide' }); });
  return { ok: r.ok === false && r.problems.some((p) => /malformed inventory viewport/.test(p)), detail: r.problems.slice(0, 2).join('; ') };
});

// E5 — malformed containers return a useful problems list, never throw.
control('malformed inventory/sentinel CONTAINERS return a problems list (never throw)', () => {
  const a = deriveCaptureObligations({ inventory: { routes: 'nope', viewports: [] }, sentinels: clone(rawSentinels) });
  const b = deriveCaptureObligations({ inventory: clone(rawInventory), sentinels: { routes: clone(rawSentinels.routes), redirects: [] } });
  const c = deriveCaptureObligations({ inventory: clone(rawInventory), sentinels: { routes: [], redirects: clone(rawSentinels.redirects) } });
  return {
    ok:
      a.ok === false && a.problems.some((p) => /inventory\.routes is not an array/.test(p)) &&
      b.ok === false && b.problems.some((p) => /sentinels\.redirects is not an object/.test(p)) &&
      c.ok === false && c.problems.some((p) => /sentinels\.routes is not an object/.test(p)),
    detail: `${a.problems.length}/${b.problems.length}/${c.problems.length}`,
  };
});

process.stdout.write(`\n[capture-obligations-controls] ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
