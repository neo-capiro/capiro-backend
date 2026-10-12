/**
 * Canonical capture-obligation contract (CleanUp1 §8.3/§8.4/§8.5).
 *
 * ONE import-safe source of truth for every PNG a whole-suite capture MUST
 * produce and a publication MUST carry, derived from the ACTUAL committed
 * inventory / sentinel / project contracts — never a hard-coded list and never a
 * second, private filename sanitizer. It is consumed by BOTH
 * scripts/capture-baselines.mjs (the publisher) and scripts/guard-route-coverage.mjs
 * (the guard), and by tests/routes.spec.ts for the declared-redirect filename
 * namespace, so the three can never drift.
 *
 * Obligations per project:
 *   - every `captured` inventory route → `<slug(path)>.png`  (105 of 122);
 *     a captured route whose path is an explicit key of `route-sentinels.redirects`
 *     is a runtime REDIRECT and still requires its own REQUESTED-route PNG
 *     (destination content + provenance recorded), never a navigation-only proof;
 *   - every `redirect-recorded` inventory route → `redirect_<slug(path)>.png`
 *     (9 of 122). The explicit `redirect_` namespace prevents the declared
 *     `/legiwatch/*` slug from colliding with the captured `/legiwatch` PNG;
 *   - both active conditional captures from projects.mjs
 *     (`CONDITIONAL_SCREENSHOT_NAMES`) → `<name>.png`.
 *
 * Importing this module MUST be side-effect free: it reads nothing, spawns
 * nothing and requires no environment. Callers pass already-parsed contracts.
 */
import { CONDITIONAL_SCREENSHOT_NAMES, PROJECTS } from './projects.mjs';

/** Filename namespace owned by declared (redirect-recorded) redirect PNGs. */
export const REDIRECT_FILENAME_PREFIX = 'redirect_';

/**
 * The SUPPORTED (coverage → allowed route kinds) classification contract.
 *
 * Every inventory route MUST carry one of these coverage classifications, and
 * its `kind` MUST be one of the kinds that classification admits. A concrete
 * page can never be silently exempted from its PNG obligation by relabelling it
 * `module-resolved` (a module exemption), and a module-mount node can never be
 * relabelled `captured` to fabricate wildcard PNGs — the pair is validated, not
 * inferred from a filter. `module-resolved` graph nodes stay legitimate live
 * router/child obligations; they simply do not own a fabricated PNG.
 */
export const COVERAGE_KIND_CONTRACT = Object.freeze({
  captured: Object.freeze(['page', 'dynamic']),
  'redirect-recorded': Object.freeze(['redirect']),
  'module-resolved': Object.freeze(['module-mount']),
});

/** The EXISTING captured-route slug contract (underscores preserved verbatim in an array arg). */
export function routeSlug(routePath) {
  if (routePath === '/') return 'root';
  return String(routePath).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Intended captured-route PNG filename (exact, underscore-preserving). */
export function capturedRouteFilename(routePath) {
  return `${routeSlug(routePath)}.png`;
}

/** Intended declared-redirect PNG filename (namespaced, collision-proof). */
export function declaredRedirectFilename(routePath) {
  return `${REDIRECT_FILENAME_PREFIX}${routeSlug(routePath)}.png`;
}

/** Intended conditional PNG filename. */
export function conditionalFilename(name) {
  return `${name}.png`;
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const hasOwn = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

/**
 * Resolve the EXISTING content-sentinel key for a redirect destination.
 *
 * Precedence:
 *   1. the EXACT destination key when present — e.g. the reviewed
 *      `/explorer?bill=hr-2027-1234` contract, which pins the bill list /
 *      facets / detail the app ACTUALLY renders for that query; otherwise
 *   2. the destination PATHNAME, but ONLY for a destination with NO query
 *      string (a safe non-query alias such as a trailing-slash form).
 *
 * A QUERY-bearing destination is a DISTINCT content contract from its bare
 * pathname: plain `/explorer` renders the articles tab, while
 * `/explorer?bill=…` renders the bills tab/detail. It may therefore NEVER
 * silently fall back to the pathname's unrelated default content — if its exact
 * reviewed key is absent this returns null (fail-closed), exactly like any other
 * missing destination sentinel. A null result is a hard failure for every
 * caller; it is never a fallback to a weaker contract.
 */
export function sentinelKeyForDestination(sentinels, destination) {
  const routes = sentinels && sentinels.routes;
  if (!routes || !isStr(destination)) return null;
  if (hasOwn(routes, destination)) return destination;
  // Query-bearing destinations must bind an EXACT reviewed key; the pathname
  // fallback is reserved for safe non-query aliases only.
  if (String(destination).includes('?')) return null;
  const pathname = String(destination).split('?')[0] || '/';
  if (hasOwn(routes, pathname)) return pathname;
  return null;
}

/**
 * Derive the complete capture-obligation contract from the actual
 * inventory + sentinel contracts. Returns { ok, problems, projects, routes,
 * redirects, conditional, counts }; `problems` is non-empty on any malformed /
 * unknown / duplicate / colliding input or unsupported content contract.
 */
export function deriveCaptureObligations({ inventory, sentinels } = {}) {
  const problems = [];
  const inv = inventory && typeof inventory === 'object' ? inventory : null;
  const sent = sentinels && typeof sentinels === 'object' ? sentinels : null;
  if (!inv) problems.push(`inventory contract is not an object: ${JSON.stringify(inventory)}`);
  if (!sent) problems.push(`sentinels contract is not an object: ${JSON.stringify(sentinels)}`);

  const inventoryRoutes = inv && Array.isArray(inv.routes) ? inv.routes : [];
  if (!inv || !Array.isArray(inv.routes)) problems.push('inventory.routes is not an array');
  const inventoryViewports = inv && Array.isArray(inv.viewports) ? inv.viewports : [];
  if (!inv || !Array.isArray(inv.viewports)) problems.push('inventory.viewports is not an array');

  const redirectsMap =
    sent && sent.redirects && typeof sent.redirects === 'object' && !Array.isArray(sent.redirects) ? sent.redirects : {};
  if (!sent || !sent.redirects || typeof sent.redirects !== 'object' || Array.isArray(sent.redirects)) {
    problems.push('sentinels.redirects is not an object');
  }
  const sentinelRoutes =
    sent && sent.routes && typeof sent.routes === 'object' && !Array.isArray(sent.routes) ? sent.routes : {};
  if (!sent || !sent.routes || typeof sent.routes !== 'object' || Array.isArray(sent.routes)) {
    problems.push('sentinels.routes is not an object');
  }

  // ── Viewport/project contract: validated against the SHARED PROJECTS source
  // of truth (never a second duplicated literal). Malformed / missing / extra /
  // wrong-dimension / duplicate viewports all fail EXPLICITLY — a project is
  // never dropped through map/filter, and a legitimate deliberate change to the
  // shared PROJECTS contract stays possible with its inventory + baseline update.
  const projects = [];
  if (Array.isArray(inv && inv.viewports)) {
    const seenProjectNames = new Set();
    for (const v of inventoryViewports) {
      if (!v || typeof v !== 'object') {
        problems.push(`malformed inventory viewport (expected { name, width, height }): ${JSON.stringify(v)}`);
        continue;
      }
      if (!isStr(v.name) || !Number.isInteger(v.width) || !Number.isInteger(v.height)) {
        problems.push(`malformed inventory viewport (name must be a non-empty string and width/height integers): ${JSON.stringify(v)}`);
        continue;
      }
      if (seenProjectNames.has(v.name)) problems.push(`duplicate inventory viewport name: ${v.name}`);
      seenProjectNames.add(v.name);
      projects.push(v.name);
    }
    const expectedProjects = Array.isArray(PROJECTS) ? PROJECTS : [];
    const projectByname = new Map(expectedProjects.map((p) => [p.name, p]));
    for (const v of inventoryViewports) {
      if (!v || typeof v !== 'object' || !isStr(v.name)) continue;
      const exp = projectByname.get(v.name);
      if (!exp) { problems.push(`inventory viewport '${v.name}' is not declared in the shared PROJECTS contract`); continue; }
      const evp = exp.viewport || {};
      if (v.width !== evp.width || v.height !== evp.height) {
        problems.push(`inventory viewport '${v.name}' dimensions ${v.width}x${v.height} do not match the PROJECTS contract ${evp.width}x${evp.height}`);
      }
    }
    for (const p of expectedProjects) {
      if (!inventoryViewports.some((v) => v && typeof v === 'object' && v.name === p.name)) {
        problems.push(`PROJECTS viewport '${p.name}' is missing from the inventory viewports`);
      }
    }
  }

  if (!projects.length) problems.push('inventory declares no viewport/project names');
  if (!inventoryRoutes.length) problems.push('inventory declares no routes');

  // Malformed + duplicate route-path detection, plus the supported
  // (coverage → kind) classification contract.
  const seenPaths = new Set();
  for (const r of inventoryRoutes) {
    if (!r || !isStr(r.path) || !r.path.startsWith('/')) {
      problems.push(`malformed inventory route (path must be a non-empty string starting with '/'): ${JSON.stringify(r && r.path)}`);
      continue;
    }
    if (seenPaths.has(r.path)) problems.push(`duplicate inventory route path: ${r.path}`);
    seenPaths.add(r.path);

    const allowedKinds = Object.prototype.hasOwnProperty.call(COVERAGE_KIND_CONTRACT, r.coverage)
      ? COVERAGE_KIND_CONTRACT[r.coverage]
      : null;
    if (!allowedKinds) {
      problems.push(`unsupported inventory coverage classification: ${JSON.stringify(r.coverage)} for route ${r.path} (supported: captured/redirect-recorded/module-resolved)`);
    } else if (!isStr(r.kind) || !allowedKinds.includes(r.kind)) {
      problems.push(`inventory route ${r.path} coverage '${r.coverage}' is inconsistent with kind ${JSON.stringify(r.kind)} (expected ${allowedKinds.join('/')}) — a concrete page must not be reassigned to a module exemption`);
    }
    if (r.coverage === 'module-resolved' && !String(r.path).includes('*')) {
      problems.push(`inventory route ${r.path} is classified module-resolved but its path is not a module-mount wildcard — a concrete route cannot be exempted as a module`);
    }
  }

  const captured = inventoryRoutes.filter((r) => r && r.coverage === 'captured' && isStr(r.path) && r.path.startsWith('/'));
  const declared = inventoryRoutes.filter((r) => r && r.coverage === 'redirect-recorded' && isStr(r.path) && r.path.startsWith('/'));

  // ── Redirect-map relationship contract: EVERY key of `route-sentinels.redirects`
  // must bind an ACTUAL captured or declared inventory path to an EXPLICIT
  // destination. An orphan key (no owning inventory route), a malformed key or
  // destination, a relationship to a non-executable (module-mount) path, or a
  // missing required declared-redirect mapping all fail closed — a relationship
  // is never weakened into a generic fallback or silently ignored.
  const executablePaths = new Set([...captured, ...declared].map((r) => r.path));
  for (const key of Object.keys(redirectsMap)) {
    if (!isStr(key) || !key.startsWith('/')) {
      problems.push(`malformed redirect-map key (must be a path starting with '/'): ${JSON.stringify(key)}`);
      continue;
    }
    const dest = redirectsMap[key];
    if (!isStr(dest) || !dest.startsWith('/')) {
      problems.push(`malformed redirect-map destination for ${key} (must be an explicit path starting with '/'): ${JSON.stringify(dest)}`);
    }
    if (!executablePaths.has(key)) {
      problems.push(`orphan redirect-map relationship: '${key}' is not a captured or declared inventory route path`);
    }
  }
  for (const r of declared) {
    if (!hasOwn(redirectsMap, r.path)) {
      problems.push(`declared redirect ${r.path} has no required sentinels.redirects mapping (a missing relationship is not a fallback)`);
    }
  }

  // Captured routes → intended PNG; a sentinel-declared redirect keeps a
  // destination + content-sentinel provenance binding.
  const routes = [];
  for (const r of captured) {
    const hasRouteSentinel = hasOwn(sentinelRoutes, r.path);
    const hasRedirectSentinel = hasOwn(redirectsMap, r.path);
    // Every captured route MUST have an explicit, pinned content sentinel (its
    // own route sentinel, or a redirect sentinel) — no generic nav/heading/body
    // fallback is ever silently accepted.
    if (!hasRouteSentinel && !hasRedirectSentinel) {
      problems.push(`captured route ${r.path} has no sentinel entry (generic fallback forbidden)`);
    }
    const redirectDest = hasOwn(redirectsMap, r.path) ? redirectsMap[r.path] : null;
    const isRedirect = redirectDest != null;
    let sentinelKey = null;
    if (isRedirect) {
      if (!isStr(redirectDest) || !redirectDest.startsWith('/')) {
        problems.push(`captured redirect ${r.path} declares an invalid destination: ${JSON.stringify(redirectDest)}`);
      } else {
        sentinelKey = sentinelKeyForDestination(sent, redirectDest);
        if (!sentinelKey) problems.push(`captured redirect ${r.path} destination ${redirectDest} has no content sentinel (generic fallback forbidden)`);
      }
    }
    routes.push({
      path: r.path,
      filename: capturedRouteFilename(r.path),
      kind: isRedirect ? 'redirect' : 'route',
      redirectTo: isRedirect ? redirectDest : null,
      sentinelKey,
    });
  }

  // Declared redirect-recorded routes → namespaced intended PNG.
  const redirects = [];
  for (const r of declared) {
    const declaredDest = isStr(r.redirectTo) ? r.redirectTo : null;
    if (!declaredDest) { problems.push(`declared redirect ${r.path} has no destination`); continue; }
    if (!declaredDest.startsWith('/')) { problems.push(`declared redirect ${r.path} destination does not start with '/': ${declaredDest}`); continue; }
    const sentinelDest = hasOwn(redirectsMap, r.path) ? redirectsMap[r.path] : null;
    if (sentinelDest != null && sentinelDest !== declaredDest) {
      problems.push(`inconsistent redirect destination for ${r.path}: inventory '${declaredDest}' vs sentinels '${sentinelDest}'`);
    }
    const sentinelKey = sentinelKeyForDestination(sent, declaredDest);
    if (!sentinelKey) { problems.push(`declared redirect ${r.path} destination ${declaredDest} has no content sentinel (generic fallback forbidden)`); continue; }
    redirects.push({
      path: r.path,
      filename: declaredRedirectFilename(r.path),
      kind: 'redirect',
      redirectTo: declaredDest,
      sentinelKey,
    });
  }

  // Conditional active-branch obligations.
  const conditionalNames = Array.isArray(CONDITIONAL_SCREENSHOT_NAMES) ? [...CONDITIONAL_SCREENSHOT_NAMES] : [];
  if (!conditionalNames.length) problems.push('no conditional screenshot obligations are declared');
  const conditional = conditionalNames.map((name) => ({ name, filename: conditionalFilename(name) }));

  // Unsupported content contract at every redirect destination sentinel:
  // it must be data-pinned or static-pinned (a bare shell is not a contract).
  for (const o of [...routes.filter((x) => x.kind === 'redirect'), ...redirects]) {
    const entry = o.sentinelKey ? sentinelRoutes[o.sentinelKey] : null;
    if (!entry || typeof entry !== 'object') continue;
    const dataOk = Array.isArray(entry.ownEndpoints) && entry.ownEndpoints.length > 0;
    const staticOk = entry.staticOnly === true && Boolean(entry.headingRe || entry.textRe);
    if (!dataOk && !staticOk) problems.push(`redirect destination sentinel ${o.sentinelKey} (for ${o.path}) is neither data-pinned (ownEndpoints) nor static-pinned (headingRe/textRe)`);
    // The destination must also carry the forbidden absent/loading/error-state
    // contract — a destination with no forbidden-state list cannot gate its PNG.
    const forbidOk = Array.isArray(entry.forbid) && entry.forbid.length > 0 && entry.forbid.every(isStr);
    if (!forbidOk) problems.push(`redirect destination sentinel ${o.sentinelKey} (for ${o.path}) declares no forbidden-state contract (forbid list required)`);
  }

  // Filename collision refusal across ALL obligations (a shared namespace must
  // never silently overwrite another obligation's pixels).
  const owners = new Map();
  const claim = (filename, owner) => {
    if (owners.has(filename)) problems.push(`filename collision: '${filename}' is claimed by both ${owners.get(filename)} and ${owner}`);
    else owners.set(filename, owner);
  };
  for (const o of routes) claim(o.filename, `captured route ${o.path}`);
  for (const o of redirects) claim(o.filename, `declared redirect ${o.path}`);
  for (const o of conditional) claim(o.filename, `conditional ${o.name}`);

  return {
    ok: problems.length === 0,
    problems,
    projects,
    routes,
    redirects,
    conditional,
    counts: {
      captured: routes.length,
      capturedRedirects: routes.filter((r) => r.kind === 'redirect').length,
      declaredRedirects: redirects.length,
      conditional: conditional.length,
      projects: projects.length,
      executableRoutePngs: routes.length + redirects.length,
    },
  };
}

/** Expand the obligations into one expected capture record per project. */
export function expectedCaptures(obligations) {
  const out = [];
  const projects = obligations.projects ?? [];
  for (const project of projects) {
    for (const o of obligations.routes ?? []) {
      const e = { project, kind: o.kind === 'redirect' ? 'redirect' : 'route', route: o.path, filename: o.filename, file: `baselines/${project}/${o.filename}` };
      if (o.kind === 'redirect') { e.redirectTo = o.redirectTo; e.sentinelKey = o.sentinelKey; }
      out.push(e);
    }
    for (const o of obligations.redirects ?? []) {
      out.push({ project, kind: 'redirect', route: o.path, redirectTo: o.redirectTo, sentinelKey: o.sentinelKey, filename: o.filename, file: `baselines/${project}/${o.filename}` });
    }
    for (const o of obligations.conditional ?? []) {
      out.push({ project, kind: 'conditional', route: null, obligation: o.name, filename: o.filename, file: `baselines/${project}/${o.filename}` });
    }
  }
  return out;
}

/** Project directory + filename derived from a manifest `file` (`baselines/<project>/<name>`). */
function fileParts(file) {
  if (!isStr(file) || !file.startsWith('baselines/')) return null;
  const rest = file.slice('baselines/'.length).split('/');
  if (rest.length < 2) return null;
  const project = rest[0];
  const name = rest.slice(1).join('/');
  if (!isStr(project) || !isStr(name)) return null;
  return { project, name };
}

/**
 * Structural validation of a manifest capture set against the derived
 * obligations — duplicate / orphan (unknown, wrong project, or wrong filename) /
 * kind-identity mismatch / wrong destination / wrong content-sentinel / missing
 * obligation. Filesystem (existence + sha256) and policy checks stay with the
 * caller. Returns [] when the set is a faithful bijection of the obligations.
 */
export function validateManifestCaptures({ obligations, captures }) {
  const problems = [];
  const expected = expectedCaptures(obligations);
  const byKey = new Map(expected.map((e) => [`${e.project}::${e.filename}`, e]));
  const seen = new Set();
  for (const c of Array.isArray(captures) ? captures : []) {
    const parts = fileParts(c && c.file);
    if (!parts) { problems.push(`orphan/unsupported baseline capture (file must be baselines/<project>/<name>.png): ${JSON.stringify(c && c.file)}`); continue; }
    if (parts.project !== c.project) { problems.push(`capture project mismatch: file project '${parts.project}' vs recorded '${c.project}' (${c.file})`); continue; }
    const key = `${parts.project}::${parts.name}`;
    if (seen.has(key)) problems.push(`duplicate manifest capture ${key}`);
    seen.add(key);
    const exp = byKey.get(key);
    if (!exp) { problems.push(`orphan baseline capture not in inventory/obligations: ${key}`); continue; }
    if (exp.kind === 'conditional') {
      if (!(c.kind === 'conditional' && c.route == null && c.obligation === exp.obligation)) {
        problems.push(`conditional capture ${key} identity mismatch (expected obligation ${exp.obligation}, got ${JSON.stringify({ kind: c.kind, route: c.route, obligation: c.obligation })})`);
      }
    } else {
      if (c.kind !== exp.kind) problems.push(`capture ${key} kind must be '${exp.kind}', got ${JSON.stringify(c.kind)}`);
      if (c.route !== exp.route) problems.push(`capture ${key} route must be '${exp.route}', got ${JSON.stringify(c.route)}`);
      if (exp.kind === 'redirect') {
        if (c.redirectTo !== exp.redirectTo) problems.push(`capture ${key} destination must be '${exp.redirectTo}', got ${JSON.stringify(c.redirectTo)}`);
        if (c.sentinelKey !== exp.sentinelKey) problems.push(`capture ${key} content-sentinel provenance must be '${exp.sentinelKey}', got ${JSON.stringify(c.sentinelKey)}`);
      }
    }
  }
  for (const e of expected) {
    if (!seen.has(`${e.project}::${e.filename}`)) {
      problems.push(`missing baseline capture for ${e.kind} ${e.project}::${e.filename}${e.route ? ` (route ${e.route})` : e.obligation ? ` (obligation ${e.obligation})` : ''}`);
    }
  }
  return problems;
}
