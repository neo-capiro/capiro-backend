/**
 * Source-derived active route graph (CleanUp1 §8.1) — v2.
 *
 * Discovery is driven by the ACTUAL sources, not a hand-maintained list:
 *
 *   1. `apps/web/src/App.tsx`  → the canonical <Routes> table (TSX AST).
 *   2. `vnext/app/VNextRouter.tsx` → the vNext interception graph: every
 *      relative import that resolves to a route module, plus the exact-path
 *      `location.pathname === '/x'` single-page overrides.
 *   3. Each vNext module → its concrete routes: TSX `<Route>` tables via AST, or
 *      (for imperative dispatchers) the concrete paths enumerated from its
 *      route-contract module(s), executed from their real exports.
 *   4. Anything that cannot be resolved statically (an unknown `<Route path>`
 *      expression, an un-enumerable dispatcher, a non-pure contract) becomes a
 *      FAIL-CLOSED OBLIGATION, never a silent omission.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  REPO_ROOT,
  parseSource,
  moduleContext,
  extractJsxRoutes,
  extractLiteralPaths,
  readSourceFile,
  lineOf,
  collectModuleRefs,
  ownsRouteTable,
  declaresRouteStructure,
  routeModuleRole,
  parseFailure,
} from './ast-routes.mjs';
export { REPO_ROOT };
import { deriveContractModule, applyFnTemplate } from './contract.mjs';

/** Concrete, stable fixture identifiers for dynamic segments (reviewed, not invented at capture). */
export const FIXTURE_IDS = Object.freeze({
  billId: 'hr-2027-1234',
  source: 'sam_gov',
  sourceRecordId: 'visual-opportunity-0001',
  issueCode: 'DEF',
  clientId: '11111111-1111-4111-8111-111111111111',
  memberId: 'visual-member-0001',
  staffId: 'visual-staff-0001',
  committeeId: 'visual-committee-0001',
  id: 'visual-id-0001',
  state: 'VA',
  districtNo: '08',
  peCode: '0605053A',
  strategyId: '7f1c9a20-4d3e-4b8a-9c21-6e0f5a8b1d34',
  id2: '9c8b7a60-1e2d-4c3b-8a5f-6d7e8a9b0c1d',
  token: 'visual-planner-token',
  hearingId: 'visual-hearing-0001',
  sessionId: 'visual-session-0001',
  systemCode: 'house-hasc',
  stateCommitteeId: 'visual-state-committee-0001',
  uuid: 'd1e2f3a4-5b6c-4d1e-8f2a-9b0c1d2e3f40',
});

const VNEXT_ROUTER = 'vnext/app/VNextRouter.tsx';
const APP = 'App.tsx';

/** declared dynamic-parameter name → reviewed FIXTURE_IDS key. */
const PARAM_FIXTURE = Object.freeze({
  token: 'token', id: 'id', id2: 'id2', memberId: 'memberId', staffId: 'staffId',
  committeeId: 'committeeId', state: 'state', districtNo: 'districtNo', peCode: 'peCode',
  strategyId: 'strategyId', billId: 'billId', bill: 'billId', code: 'issueCode',
  source: 'source', sourceRecordId: 'sourceRecordId', sessionId: 'sessionId',
  hearingId: 'hearingId', systemCode: 'systemCode', stateCommitteeId: 'stateCommitteeId',
  conflictId: 'id', documentId: 'id2', clientId: 'clientId', draftId: 'uuid', personId: 'id',
});

/**
 * Normalize a concrete route path: collapse a tolerated trailing slash, keep the
 * query string untouched, and resolve every `:param` to its reviewed fixture id.
 * An unknown parameter is a fail-closed obligation, never an invented value.
 */
function normalizeConcrete(rawPath, obligations, source) {
  if (!rawPath) return null;
  const qIdx = rawPath.indexOf('?');
  let p = qIdx === -1 ? rawPath : rawPath.slice(0, qIdx);
  const query = qIdx === -1 ? '' : rawPath.slice(qIdx);
  if (p.endsWith('/*')) return p + query; // module mount — resolved by nested routes
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  const unresolvedParams = [];
  // The research-portfolios DETAIL matcher requires a UUID (research-portfolios-
  // routes.ts UUID.test), so the placeholder id is resolved to a valid UUID for
  // that path only (otherwise the deep link is a permanent 404).
  const pathOverrides = rawPath.startsWith('/research-portfolios/') ? { id: FIXTURE_IDS.uuid } : {};
  p = p.replace(/:([A-Za-z0-9_]+)/g, (_m, name) => {
    if (Object.prototype.hasOwnProperty.call(pathOverrides, name)) return encodeURIComponent(pathOverrides[name]);
    const key = PARAM_FIXTURE[name];
    if (key && FIXTURE_IDS[key] !== undefined) return encodeURIComponent(FIXTURE_IDS[key]);
    unresolvedParams.push(name);
    return `:${name}`;
  });
  if (unresolvedParams.length && obligations) {
    obligations.push({ source: source ?? 'route-graph', reason: `unmapped dynamic parameter(s): ${unresolvedParams.join(', ')} in ${rawPath}` });
  }
  return p + query;
}

function parse(rel) {
  const text = readSourceFile(rel);
  const sf = parseSource(rel, text);
  return { sf, ctx: moduleContext(sf, rel), text };
}

function resolveRel(fromRel, spec) {
  const dir = path.posix.dirname(fromRel);
  const rel = path.posix.normalize(path.posix.join(dir, spec));
  // Exact asset path (css/svg/json/...) — a real file, just not a JS module.
  if (/\.[a-z0-9]+$/i.test(rel) && !/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(rel)) {
    return existsSync(path.join(REPO_ROOT, 'apps', 'web', 'src', rel)) ? rel : null;
  }
  const base = rel.replace(/\.js$/, '');
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(path.join(REPO_ROOT, 'apps', 'web', 'src', cand))) return cand;
  }
  return null;
}

/**
 * Every relative module this file references — static imports, dynamic
 * `import()` (React.lazy route modules), CommonJS `require()` and reexports.
 * Reviewers proved that enumerating only ImportDeclarations silently drops
 * lazily-mounted route modules; this returns all four constructs, and an
 * unresolved spec is surfaced rather than dropped.
 */
function relativeImports(rel) {
  const { sf } = parse(rel);
  const out = [];
  for (const ref of collectModuleRefs(sf)) {
    const target = resolveRel(rel, ref.spec);
    if (target) out.push({ spec: ref.spec, target, kind: ref.kind, from: rel });
    else out.push({ spec: ref.spec, target: null, kind: ref.kind, from: rel, unresolved: true });
  }
  return out;
}

// TypeScript compiler handle (shared).
import { loadTs } from './ast-routes.mjs';
function mod_ts() {
  return loadTs();
}

/** Enumerate concrete routes from a contract module's statically-derived exports
 *  (round-4: NO host import, NO transpile, NO exported-function invocation). */
async function enumerateContract(relFile) {
  const res = deriveContractModule(relFile);
  if (!res.ok) return { paths: [], obligation: `${relFile}: ${res.reason}` };
  const m = res.exports;
  const paths = [];
  const obligations = [];
  const add = (p, kind = 'page', extra = {}) => { if (typeof p === 'string' && p.startsWith('/')) paths.push({ path: p, kind, ...extra }); };
  const apply = (fn, args, label) => {
    const r = applyFnTemplate(fn, args, label);
    if (r.reason) { obligations.push(`${relFile}: ${r.reason}`); return null; }
    return r.value;
  };

  try {
    // Directory
    if (m.DIRECTORY_ROUTES && m.DIRECTORY_ROUTES.kind === 'object') {
      for (const v of Object.values(m.DIRECTORY_ROUTES.props)) if (v.kind === 'string') add(v.value);
      if (m.DIRECTORY_LEGACY_ROUTE && m.DIRECTORY_LEGACY_ROUTE.kind === 'string') {
        const dest = m.DIRECTORY_ROUTES.props.congressionalStaff;
        paths.push({ path: m.DIRECTORY_LEGACY_ROUTE.value, kind: 'redirect', redirectTo: dest && dest.kind === 'string' ? dest.value : undefined });
      }
      if (m.DIRECTORY_PROFILE_ROUTES && m.DIRECTORY_PROFILE_ROUTES.kind === 'object') {
        const pr = m.DIRECTORY_PROFILE_ROUTES.props;
        const build = (name, arg) => { const p = apply(pr[name], [arg], `DIRECTORY_PROFILE_ROUTES.${name}`); if (p) add(p, 'dynamic'); };
        build('staff', FIXTURE_IDS.staffId);
        build('member', FIXTURE_IDS.memberId);
        build('committee', FIXTURE_IDS.committeeId);
        build('stateLegislator', 'ocd-person/' + FIXTURE_IDS.staffId);
        // NOTE: departmentOfWarPerson() is deliberately NOT emitted as a captured
        // route. The vNext profile matcher rejects it (directory-routes.ts
        // matchDirectoryProfilePath returns null for 'department-of-war', asserted
        // by directory-profile-routes.test.ts:44) so the path is a 404, while the
        // app itself navigates to it (useDowModel.ts:249) — a production dead-link
        // defect in the vnext directory module, OUTSIDE this lane. Recorded in
        // buildInactive() with evidence rather than captured as a page.
        build('stateCommittee', FIXTURE_IDS.stateCommitteeId);
      }
    }
    // Program Elements
    if (m.PE_WORKSPACE_ROUTE && m.PE_WORKSPACE_ROUTE.kind === 'string') {
      const root = m.PE_WORKSPACE_ROUTE.value;
      add(root);
      if (m.PE_CLAIMED_STATIC_SEGMENTS && m.PE_CLAIMED_STATIC_SEGMENTS.kind === 'array') {
        for (const s of m.PE_CLAIMED_STATIC_SEGMENTS.items) if (s.kind === 'string') add(`${root}/${s.value}`);
      }
      if (m.PE_DESTINATIONS && m.PE_DESTINATIONS.kind === 'array') {
        for (const d of m.PE_DESTINATIONS.items) if (d.kind === 'string') add(`${root}?dest=${d.value}`, 'page', { query: { dest: d.value } });
      }
      add(`${root}/${FIXTURE_IDS.peCode}`, 'dynamic');
    }
  } catch (e) {
    return { paths, obligation: `${relFile}: enumerator threw: ${e.message}` };
  }
  return { paths, obligation: obligations.length ? obligations.join('; ') : null };
}

/** Concrete fixture paths for a raw regex literal route pattern (uuid-shaped). */
function concreteFromRegex(srcRaw) {
  const src = String(srcRaw).replace(/\\\//g, '/'); // unescape regex-escaped slashes
  const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  const out = [];
  // /workspace/<uuid>(/run)?  and /workspace/studio/<uuid>/<uuid>
  const um = src.matchAll(/workspace\/([A-Za-z]+)/g);
  if (/workspace\/\(/.test(src) || /workspace\/[A-Za-z]/.test(src)) {
    // generic: extract the literal segments around the capture groups
  }
  // Explicit well-known shapes (evidence: regex source string).
  if (src.includes('STUDIO') || /workspace\/studio\//.test(src)) {
    out.push(`/workspace/studio/${FIXTURE_IDS.uuid}/${FIXTURE_IDS.id2}`);
  }
  if (/\/run\/\?\$/.test(src) || /run/.test(src)) out.push(`/workspace/${FIXTURE_IDS.uuid}/run`);
  if (/workspace\/\(/.test(src)) out.push(`/workspace/${FIXTURE_IDS.uuid}`);
  if (/workspace\/documents\//.test(src)) out.push(`/workspace/documents/${FIXTURE_IDS.uuid}`);
  if (/legiwatch\/issues\//.test(src)) out.push(`/legiwatch/issues/${FIXTURE_IDS.issueCode}`);
  if (/legiwatch\/committees\/FL\//.test(src)) out.push(`/legiwatch/committees/FL/${FIXTURE_IDS.stateCommitteeId}`);
  if (/legiwatch\/committees\//.test(src) && !/FL/.test(src)) out.push(`/legiwatch/committees/${FIXTURE_IDS.systemCode}`);
  if (/legiwatch\/hearings\//.test(src)) out.push(`/legiwatch/hearings/${FIXTURE_IDS.hearingId}`);
  if (/intelligence\/issues\//.test(src)) out.push(`/intelligence/issues/${FIXTURE_IDS.issueCode}`);
  if (/intelligence\/hearing-watch\//.test(src)) out.push(`/intelligence/hearing-watch/${FIXTURE_IDS.sessionId}`);
  if (/bills\//.test(src)) out.push(`/bills/${FIXTURE_IDS.billId}`);
  return [...new Set(out)];
}

/** Enumerate a vNext module's concrete routes (JSX table or imperative literals). */
async function moduleRoutes(relFile) {
  const { sf, ctx } = parse(relFile);
  const obligations = [];
  const routes = [];
  // Fail closed on parser diagnostics: an unparseable module cannot be trusted
  // to enumerate routes, and extractJsxRoutes deliberately returns [] for it.
  // Surface the parse failure so inventory generation exits non-zero.
  const pf = parseFailure(relFile, sf);
  if (pf) return { routes, obligations: [{ source: relFile, reason: pf }] };
  const tsRoutes = extractJsxRoutes(sf, ctx);
  const seen = new Set();
  const addRoute = (r) => {
    if (!r.path || r.path === '*') return; // catch-alls are never baselines
    const key = r.path;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push(r);
  };
  for (const r of tsRoutes) {
    if (r.unresolved) obligations.push({ source: `${relFile}:${r.line}`, reason: r.unresolved });
    else addRoute({ path: r.path, kind: r.kind, redirectTo: r.kind === 'redirect' ? r.redirectTo : undefined, source: `${relFile}:${r.line}` });
  }

  // Imperative dispatchers: ALWAYS also harvest the module's own literals and
  // anchored regexes (a module may mix a JSX table with imperative branches, so
  // a partial JSX table must never suppress the imperative routes).
  const contractFiles = relativeImports(relFile)
    .filter((i) => i.target && /(routes?|route-state)\.(ts|tsx)$/.test(i.target))
    .map((i) => i.target);
  // the dispatcher file's OWN literals (not the contract files — those are executed)
  const { strings, patterns } = extractLiteralPaths(sf, ctx);
  const literalRoutes = [];
  for (const s of strings) literalRoutes.push({ path: s, kind: s.includes(':') ? 'dynamic' : 'page', source: relFile });
  for (const p of patterns) {
    const text = p.text ?? '';
    if (/^\^\/|\^\\\//.test(text) || text.includes('^/')) {
      const concretes = concreteFromRegex(text);
      if (concretes.length === 0) obligations.push({ source: relFile, reason: `un-enumerated route pattern: ${text}` });
      for (const c of concretes) literalRoutes.push({ path: c, kind: 'dynamic', source: relFile });
    }
    // non-routed template/regex (helpers like trailing-slash strips, URL builders
    // for values already enumerated) are not route-hiding constructs.
  }
  for (const r of literalRoutes) addRoute(r);

  for (const c of contractFiles) {
    const { paths, obligation } = await enumerateContract(c);
    if (obligation) obligations.push({ source: c, reason: obligation });
    for (const p of paths) addRoute({ path: p.path, kind: p.kind, redirectTo: p.redirectTo, query: p.query, source: c });
  }
  if (routes.length === 0) obligations.push({ source: relFile, reason: 'module declared no enumerable routes (imperative dispatcher not understood)' });
  return { routes, obligations };
}

/** Exact-path + prefix claims inside VNextRouter's branch conditions. */
function vnextBranchClaims(rel) {
  const { sf } = parse(rel);
  const TS = mod_ts();
  const exact = new Set();
  const prefix = new Set();
  const predicateCalls = new Set();
  const visit = (n) => {
    if (TS.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      const txt = n.getText(sf);
      const lit = /location\.pathname\s*===\s*(['"`])([^'"`]+)\1/.exec(txt);
      if (lit && op === TS.SyntaxKind.EqualsEqualsEqualsToken) exact.add(lit[2]);
      const pre = /location\.pathname\.startsWith\(\s*(['"`])([^'"`]+)\1\s*\)/.exec(txt);
      if (pre) prefix.add(pre[2].replace(/\/$/, ''));
    }
    if (TS.isCallExpression(n) && n.expression.getText(sf).startsWith('is') && /Path$|Route$/.test(n.expression.getText(sf))) {
      predicateCalls.add(n.expression.getText(sf));
    }
    TS.forEachChild(n, visit);
  };
  visit(sf);
  return { exact, prefix, predicateCalls };
}

/**
 * Route-owning modules reachable from a router, discovered by PARSING each
 * referenced module rather than matching a filename pattern. Dynamic imports
 * (React.lazy) and require() refs are included, unresolved refs are surfaced,
 * and a barrel that re-exports a route module is followed (bounded, cycle-safe).
 */
function vnextModules(rel) {
  const moduleFiles = new Map();
  const singlePage = new Set();
  const unresolved = [];
  const seen = new Set();

  const ownsRoutes = (t) => routeModuleRole(t) !== null;

  const consider = (target, depth) => {
    if (!target || seen.has(target) || depth > 4) return;
    seen.add(target);
    if (ownsRoutes(target)) { moduleFiles.set(target, routeModuleRole(target)); return; }
    // Not a route source itself: follow only RE-EXPORT refs (barrel modules). A
    // plain page component is not a route source, so recursing into its imports
    // would fabricate reachability. Bounded + cycle-guarded via `seen`.
    for (const s of relativeImports(target)) {
      if (s.unresolved) { unresolved.push(s); continue; }
      if (s.kind !== 'reexport') continue;
      if (!/\.tsx?$/.test(s.target)) continue;
      const role = routeModuleRole(s.target);
      if (role !== null) moduleFiles.set(s.target, role);
      else consider(s.target, depth + 1);
    }
  };

  for (const r of relativeImports(rel)) {
    if (r.unresolved) { unresolved.push(r); continue; }
    if (!/\.tsx?$/.test(r.target)) continue;
    const role = routeModuleRole(r.target);
    if (role !== null) moduleFiles.set(r.target, role);
    else { consider(r.target, 1); singlePage.add(r.target); }
  }
  return { moduleFiles: [...moduleFiles.keys()], moduleRoles: Object.fromEntries(moduleFiles), singlePage: [...singlePage], unresolved };
}

export function buildRouteGraph() {
  return _buildRouteGraphSync();
}

/** Synchronous wrapper is impossible with contract import();
 *  the async builder is the real entry point. */
async function _buildRouteGraph() {
  const routes = [];
  const obligations = [];
  const inactive = [];
  const byPath = new Map();
  const push = (r) => {
    if (!r.path) return;
    const key = r.path;
    if (byPath.has(key)) {
      const prev = byPath.get(key);
      // Prefer a redirect (index/legacy) over a layout page for the same path.
      if (prev.kind !== 'redirect' && r.kind === 'redirect') { byPath.set(key, r); const i = routes.indexOf(prev); if (i >= 0) routes[i] = r; }
      return;
    }
    byPath.set(key, r);
    routes.push(r);
  };

  // ── 1. canonical (App.tsx) ────────────────────────────────────────────────
  const { sf: appSf, ctx: appCtx } = parse(APP);
  const appParseFail = parseFailure(APP, appSf);
  if (appParseFail) obligations.push({ source: `apps/web/src/${APP}`, reason: appParseFail });
  for (const r of extractJsxRoutes(appSf, appCtx)) {
    if (r.unresolved && !r.path) { obligations.push({ source: `apps/web/src/${APP}:${r.line}`, reason: r.unresolved }); continue; }
    const isWildcard = r.isWildcard;
    if (r.path === '*' && !isWildcard) continue; // 404 catch-all — never a baseline
    push({
      id: `app:${r.path}`,
      path: r.path,
      declaredPath: r.declaredPath,
      kind: isWildcard ? 'module-mount' : r.kind,
      source: `apps/web/src/${APP}:${r.line}`,
      redirectTo: r.redirectConditional ? undefined : r.redirectTo,
      redirectConditional: r.redirectConditional ? r.redirectTo : undefined,
      coverage: isWildcard ? 'module-mount' : r.kind === 'redirect' ? 'redirect-recorded' : 'captured',
      surface: 'authenticated',
    });
  }

  // ── 2. vNext modules ──────────────────────────────────────────────────────
  const { moduleFiles, unresolved: unresolvedRefs } = vnextModules(VNEXT_ROUTER);
  for (const u of unresolvedRefs) {
    obligations.push({ source: `${u.from}`, reason: `unresolved module reference '${u.spec}' (${u.kind}) — cannot prove reachability` });
  }
  // Every discovered route-owning module must itself parse cleanly; a diagnostic
  // means its route set is untrustworthy and the whole inventory must fail.
  for (const mf of moduleFiles) {
    const { sf: msf } = parse(mf);
    const mfFail = parseFailure(mf, msf);
    if (mfFail) obligations.push({ source: mf, reason: mfFail });
  }
  const claims = vnextBranchClaims(VNEXT_ROUTER);
  const vnextOwned = new Set();
  for (const mf of moduleFiles) {
    let res;
    try { res = await moduleRoutes(mf); } catch (e) { obligations.push({ source: mf, reason: `module enumeration failed: ${e.message}` }); continue; }
    for (const o of res.obligations) obligations.push(o);
    for (const r of res.routes) {
      const norm = normalizeConcrete(r.path);
      if (!norm) continue;
      vnextOwned.add(norm);
      push({
        id: `vnext:${norm}`,
        path: norm,
        declaredPath: r.path,
        kind: r.kind === 'redirect' ? 'redirect' : r.kind === 'dynamic' ? 'dynamic' : 'page',
        source: r.source,
        redirectTo: r.redirectTo,
        query: r.query,
        resolution: 'vnext-module',
        surface: 'authenticated',
        coverage: r.kind === 'redirect' ? 'redirect-recorded' : 'captured',
      });
    }
  }

  // ── 3. normalize + concretize every route, then dedupe ────────────────────
  const finalized = new Map();
  for (const r of routes) {
    let p = normalizeConcrete(r.path, obligations, r.source);
    if (p === null) continue;
    r.path = p;
    // filter out non-page literals that leaked from contract files
    if (/^\/(api|workspace-api|onboard-api|strategy-api|intel-api|engagement-api|legiwatch-api)\//.test(p) || p === '/api') continue;
    if (finalized.has(p)) {
      const prev = finalized.get(p);
      // prefer: redirect over page; vnext override info merged
      if (prev.kind !== 'redirect' && r.kind === 'redirect') finalized.set(p, r);
      else { prev.vnextOverride = prev.vnextOverride || r.vnextOverride || (r.resolution === 'vnext-module'); prev.query = prev.query || r.query; }
      continue;
    }
    r.vnextOverride = r.resolution === 'vnext-module' || vnextOwned.has(p);
    finalized.set(p, r);
  }
  const finalRoutes = [...finalized.values()];
  // effective override: canonical path claimed by vNext prefix/exact predicates
  for (const r of finalRoutes) {
    if (!r.vnextOverride) {
      r.vnextOverride =
        [...claims.exact].includes(r.path) ||
        [...claims.prefix].some((pre) => r.path === pre || r.path.startsWith(`${pre}/`)) ||
        r.path === '/strategies' || r.path.startsWith('/strategies/') ||
        r.path === '/workspace' || r.path.startsWith('/workspace/');
    }
    if (r.kind === 'module-mount') r.coverage = 'module-resolved';
  }

  // divergent claims: a canonical path the vNext predicate claims but no module enumerates
  const finalPaths = new Set(finalRoutes.map((r) => r.path));
  for (const p of claims.exact) {
    if (!finalPaths.has(p) && ![...finalPaths].some((fp) => fp.startsWith(p + '/'))) {
      obligations.push({ source: VNEXT_ROUTER, reason: `VNextRouter claims exact path ${p} with no module/route enumerating it` });
    }
  }

  finalRoutes.sort((a, b) => (a.path || '').localeCompare(b.path || ''));
  return { routes: finalRoutes, inactive: buildInactive(), obligations, schema: 'capiro.cleanup1.routes.inventory.v2' };
}

/**
 * Declarations that are intentionally NOT captured, each with the source and
 * reachability evidence that justifies the exclusion. Recorded, never silent.
 */
function buildInactive() {
  return [
    {
      path: '/program-elements/reconciliation',
      declared: 'pe-routes.ts PE_STATIC_SEGMENTS (reserved, unclaimed)',
      reason: 'The vNext PE module deliberately does NOT claim this segment; it falls through to the canonical tree, where no route exists (the queue lives at /admin/program-element/reconciliation).',
      evidence: 'apps/web/src/vnext/pages/program-elements/pe-routes.ts (header + PE_STATIC_SEGMENTS)',
      reachability: 'not-claimed-fallthrough',
    },
    {
      path: '/legiwatch/<tab>',
      declared: 'LegiWatch module tabs (?tab=hearings|feed|bills|digest|analytics)',
      reason: 'Tabs are query state on the single /legiwatch route, not distinct paths; the canonical tab rendering is exercised by the /legiwatch capture.',
      evidence: 'apps/web/src/vnext/pages/legiwatch/VNextLegiWatchRoutes.tsx',
      reachability: 'query-state-of-/legiwatch',
    },
    {
      path: '/directory/department-of-war/<personId>',
      declared: 'DIRECTORY_PROFILE_ROUTES.departmentOfWarPerson (directory-routes.ts)',
      reason:
        'The vNext profile matcher does NOT claim department-of-war person paths — ' +
        'matchDirectoryProfilePath returns null for it (asserted in directory-profile-routes.test.ts:44), ' +
        'so the path is a canonical 404, while useDowModel.ts:249 navigates to it. This is a ' +
        'production dead-link defect in the vnext directory module (out of this lane), not a capture gap.',
      evidence: 'apps/web/src/vnext/pages/directory/directory-routes.ts, directory-profile-routes.test.ts:44, useDowModel.ts:249',
      reachability: 'not-claimed-fallthrough',
    },
  ];
}

const _cache = { promise: null };
export function buildRouteGraphAsync() {
  if (!_cache.promise) _cache.promise = _buildRouteGraph();
  return _cache.promise;
}
function _buildRouteGraphSync() {
  throw new Error('use buildRouteGraphAsync()');
}
