import { test, expect, type Page } from '../lib/playwright-bridge.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_SHELL_ENDPOINTS, FORBIDDEN_STATE_MARKERS } from '../lib/projects.mjs';
import { capturedRouteFilename, declaredRedirectFilename, sentinelKeyForDestination } from '../lib/capture-obligations.mjs';
import { recordRenderObservation } from '../lib/render-context.mjs';

/**
 * One Playwright test identity per concrete captured route, from the committed
 * routes.inventory.json (TSX-AST derived).
 *
 * Round-4 corrections applied here:
 *   - fixed clock uses page.clock.setFixedTime (NOT a Date subclass);
 *   - network is confined to the EXACT parsed owned server origin; every other
 *     http(s), WebSocket and service-worker attempt is denied and recorded;
 *   - every captured route requires an EXPLICIT per-route content contract from
 *     route-sentinels.json: the EXACT route-owned seeded endpoint(s) it must
 *     consume (real fixture identity — a request count is NOT a sentinel), the
 *     pinned visible content (headingRe/textRe) and/or own static content for a
 *     legitimate static page, with absent/loading/empty/handled-error states
 *     forbidden. There is no generic nav/heading/body fallback;
 *   - a requested path that lands elsewhere is an unlisted redirect failure.
 *
 * Round-21 corrections (harness defects found by the round-19 native run):
 *   - ORDER: a BOUNDED, route-derived readiness wait now runs BEFORE the single
 *     authoritative probe. Previously the probe snapshotted one-or-more ticks
 *     before React Query effects / lazy route chunks settled, so every data
 *     route failed the own-endpoint assertion with a byte-identical
 *     shared-shell-only `consumed` list. Readiness polls on the sentinel's OWN
 *     contract (own endpoint observed + no forbidden loading/error marker),
 *     bounded by READY_TIMEOUT_MS; there is no unconditional blanket sleep and
 *     no relaxed assertion — a genuinely missing endpoint still fails, and a
 *     timeout fails with the last observed probe instead of falling through.
 *   - REDIRECT vs QUERY CANONICALIZATION: a landing on the SAME pathname is
 *     never a redirect. The app canonicalizes the query string (fills defaults
 *     such as date on calendar routes, tab=contracts or client=all; drops the defaulted
 *     ?period=current) without changing the path. Same-pathname landings must
 *     instead PRESERVE every meaningful requested param unless the sentinel
 *     explicitly declares it defaulted (cfg.queryDefaults). Exact pathname
 *     redirect checks remain fully enforced via sentinels.redirects.
 *   - SHELL-FREE ROUTES: a real renderer that legitimately runs OUTSIDE the
 *     vNext shell (the public planner form) is asserted via an explicit
 *     `shellFree` sentinel flag: the shell-root precondition is skipped, but
 *     headingRe/textRe/ownEndpoints/forbid/minBodyChars all still apply. No
 *     shell is fabricated for it.
 *   - REDIRECT READINESS: redirect tests await a bounded destination readiness
 *     before asserting, so a lazy route chunk that claims the path a tick later
 *     is not read as "no redirect".
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.inventory.json'), 'utf8'));

const sentinelsPath = path.join(ROOT, 'route-sentinels.json');
if (!fs.existsSync(sentinelsPath)) throw new Error('route-sentinels.json is required (fail-closed: no generic sentinel fallback)');
const sentinels = JSON.parse(fs.readFileSync(sentinelsPath, 'utf8'));

const FIXED_CLOCK = '2026-10-07T12:00:00.000Z';

// The ONE owned offline origin (exact scheme+host+port), parsed — never a
// substring/prefix match that would admit localhost.example or another port.
const BASE = process.env.CAPIRO_VISUAL_BASE_URL || 'http://127.0.0.1:4190';
const OWNED = new URL(BASE);
const OWNED_ORIGIN = OWNED.origin;
const OWNED_WS = `ws://${OWNED.host}`;

const SHARED_SHELL = new Set<string>(SHARED_SHELL_ENDPOINTS);

// Bounded route-derived readiness budget. NOT a blanket sleep: readiness ends
// the instant the route-derived condition holds, and this only caps how long we
// wait before failing with the last observed probe.
const READY_TIMEOUT_MS = 15_000;

/** Strip a trailing slash (whole string, query included) — mirrors the app's index normalisation. */
const norm = (s: string) => s.replace(/\/$/, '') || '/';
/** Pathname only (trailing slash stripped) — the redirect contract is pathname based. */
const pathOnly = (s: string) => {
  const p = s.split('?')[0] || '/';
  return p.replace(/\/$/, '') || '/';
};
/** Parsed [key, value] pairs of a path+search string (empty when no `?`). */
function queryPairs(s: string): Array<[string, string]> {
  const i = s.indexOf('?');
  if (i < 0) return [];
  return [...new URLSearchParams(s.slice(i + 1)).entries()];
}

export function slug(p: string): string {
  if (p === '/') return 'root';
  return p.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const KILL_MOTION = `(() => {
  const apply = () => {
    const root = document.head || document.documentElement; if (!root) return;
    const s = document.createElement('style');
    s.setAttribute('data-visual-determinism', '1');
    s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}';
    root.appendChild(s);
  };
  apply();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
})();`;

type Containment = {
  blockedHttp: string[];
  blockedWs: string[];
  swRegistrationDenied: boolean | null;
};

const containmentByPage = new WeakMap<Page, Containment>();

// Actual render-context observation (round 73): the specs record the REAL page
// context (viewport/colour/media/locale/timezone/DPR/motion + the ACTUAL applied
// fixed clock) for every captured page so the producer can prove the pixels'
// renderer context instead of probing a synthetic context. A no-op unless the
// producer supplies CAPIRO_RENDER_OBSERVATIONS.
const OBS_FILE = process.env.CAPIRO_RENDER_OBSERVATIONS || '';
const OBS_PHASE = process.env.CAPIRO_RENDER_PHASE || 'capture';
async function recordContext(page: Page): Promise<void> {
  // Plain runs (no producer-supplied observation path) record nothing: a no-op.
  // When the producer DID supply a path, a recording failure must FAIL this test
  // (fail closed): swallowing it could silently drop one page's observation while
  // other pages already recorded each project, so aggregation could still
  // "succeed" on an incomplete set. (root review round 80)
  if (!OBS_FILE) return;
  const recorded = await recordRenderObservation({ file: OBS_FILE, phase: OBS_PHASE, project: test.info().project.name, page });
  if (recorded !== true) throw new Error(`render-context observation was not recorded for ${test.info().project.name}`);
}

/** Exact-origin confinement + WebSocket deny + service-worker deny proof. */
async function confine(page: Page, routePath: string, opts: { shellFree?: boolean } = {}) {
  const rec: Containment = { blockedHttp: [], blockedWs: [], swRegistrationDenied: null };
  containmentByPage.set(page, rec);

  // HTTP(S): continue ONLY the exact owned origin (or non-network schemes);
  // abort + record every other origin.
  await page.route('**/*', async (r) => {
    let url: URL;
    try { url = new URL(r.request().url()); } catch { await r.abort('blockedbyclient'); rec.blockedHttp.push(r.request().url()); return; }
    const scheme = url.protocol;
    if (scheme === 'data:' || scheme === 'blob:' || scheme === 'about:') return r.continue();
    if ((scheme === 'http:' || scheme === 'https:') && url.origin === OWNED_ORIGIN) return r.continue();
    rec.blockedHttp.push(r.request().url());
    await r.abort('blockedbyclient');
  });

  // WebSockets: connect ONLY the owned origin; deny every other socket.
  await page.routeWebSocket(/.*/, (ws) => {
    try {
      const u = new URL(ws.url());
      const ownedWs = u.protocol === 'ws:' && `${u.protocol}//${u.host}` === OWNED_WS;
      if (ownedWs) { ws.connectToServer(); return; }
    } catch { /* fall through to deny */ }
    rec.blockedWs.push(ws.url());
    ws.close({ code: 1008, reason: 'visual-offline-containment' });
  });

  await page.addInitScript(KILL_MOTION);
  // Required determinism API: fixes Date WITHOUT pausing timers.
  await page.clock.setFixedTime(new Date(FIXED_CLOCK));
  await page.goto(routePath, { waitUntil: 'load' });
  // Bounded readiness wait for the shell to mount. This is NOT a content
  // sentinel — content correctness is asserted separately and fail-closed.
  // A shell-free route (public planner form) legitimately has no vNext shell
  // root, so the selector wait is skipped for it rather than timing out.
  if (!opts.shellFree) {
    await page.waitForSelector('.capiro-vnext-root', { timeout: 45_000 }).catch(() => {});
  }
  // Record the ACTUAL page context of the page this test will capture.
  await recordContext(page);
  return rec;
}

export type Probe = {
  requested: string;
  landed: string;
  root: boolean;
  headings: string[];
  bodyText: string;
  bodyLen: number;
  gaps: Array<{ url: string; method: string; status?: string }>;
  seeded: string[];
  hits: string[];
  swController: boolean;
};

export type Sentinel = {
  ownEndpoints: string[];
  staticOnly: boolean;
  headingRe?: string;
  textRe?: string;
  forbid: string[];
  minBodyChars?: number;
  /**
   * True for a real renderer that intentionally runs OUTSIDE the vNext shell
   * (the public planner form). It skips ONLY the shell-root precondition —
   * headingRe/textRe/ownEndpoints/forbid/minBodyChars still apply. It is never
   * used to skip a shell for a route that should have one.
   */
  shellFree?: boolean;
  /**
   * Requested query params the app legitimately canonicalizes AWAY on a
   * same-pathname landing (e.g. a defaulted `period=current`). This is an
   * explicit per-route opt-out for MEANINGFUL, requested-to-removed params;
   * every other requested param must survive on the landed URL.
   */
  queryDefaults?: Record<string, string>;
};

async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __VISUAL_FIXTURE_GAPS__?: Array<{ url: string; method: string; status?: string }>;
      __VISUAL_FIXTURE_SEEDED__?: string[];
      __VISUAL_FIXTURE_HITS__?: string[];
    };
    return {
      requested: location.pathname + location.search,
      landed: location.pathname + location.search,
      root: Boolean(document.querySelector('.capiro-vnext-root')),
      headings: Array.from(document.querySelectorAll('h1,h2,h3,[role=heading]')).map((h) => (h.textContent || '').trim()),
      bodyText: (document.body?.innerText || ''),
      bodyLen: (document.body?.innerText || '').trim().length,
      gaps: (w.__VISUAL_FIXTURE_GAPS__ || []).slice(-12),
      seeded: (w.__VISUAL_FIXTURE_SEEDED__ || []).slice(-64),
      hits: (w.__VISUAL_FIXTURE_HITS__ || []).slice(-64),
      swController: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
    };
  });
}

function pathOf(entry: string): string {
  const u = entry.replace(/^[A-Za-z]+ /, '');
  const bare = u.split('?')[0] || u;
  try { return new URL(bare, BASE).pathname; } catch { return bare; }
}

/** Explicit per-route sentinel contract; missing entry is a hard failure. */
export function sentinelFor(routePath: string): Sentinel {
  const entry = sentinels.routes?.[routePath];
  if (!entry) {
    throw new Error(
      `no explicit sentinel for ${routePath} in route-sentinels.json — a generic nav/heading/body fallback is forbidden`,
    );
  }
  return entry as Sentinel;
}

/** Seeded endpoints consumed OUTSIDE the always-present shared shell. */
export function ownSeeded(seeded: string[]): string[] {
  return seeded.map(pathOf).filter((p) => !SHARED_SHELL.has(p));
}

/** Fonts + two RAFs settle (determinism) — applied AROUND the readiness wait. */
async function settleFontsRaf(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}

/**
 * Bounded, route-derived readiness BEFORE the authoritative probe.
 *
 * The ready condition is derived from the sentinel contract itself: no
 * forbidden loading/empty/error marker visible, the route's pinned headingRe
 * and textRe (when present) already match, and — for a data route — one of its
 * OWN seeded endpoints has been consumed. The poll is Playwright's own in-page
 * polling (no blanket sleep) and is capped by READY_TIMEOUT_MS. On failure this
 * THROWS with the last observed probe — it never falls through to a weaker
 * assertion.
 *
 * Round-21b diagnostics (additive; the wait itself is UNCHANGED — same bounded
 * budget, same predicate, same authoritative assertContent downstream):
 *   - the ACTUAL `page.waitForFunction` rejection is PRESERVED. The previous
 *     `.catch(() => false)` swallowed it and mislabelled it as a readiness
 *     TIMEOUT. `waitError` now carries the rejection message, so a readiness
 *     TIMEOUT and a runtime/serialization rejection can be distinguished.
 *   - the failure evaluate reports EVERY predicate clause independently
 *     (forbidden / headingRe / textRe / minBody / own endpoints) and scans the
 *     FULL visible body for forbidden markers — not just a 240-char head slice,
 *     which could report `forbiddenMarkers=[]` while a marker deeper in the page
 *     kept the predicate false — so a focused rerun can tell a genuinely missing
 *     condition from a runtime error.
 */
async function waitForRouteReady(page: Page, cfg: Sentinel, routePath: string): Promise<void> {
  const want = (cfg.ownEndpoints ?? []).map(pathOf);
  const forbid = [...(cfg.forbid ?? []), ...FORBIDDEN_STATE_MARKERS];
  const minBody = typeof cfg.minBodyChars === 'number' ? cfg.minBodyChars : 0;
  const headingRe = cfg.headingRe ?? '';
  const textRe = cfg.textRe ?? '';

  await settleFontsRaf(page);
  let waitError = '';
  const ok = await page
    .waitForFunction(
      (arg: { want: string[]; forbid: string[]; minBody: number; headingRe: string; textRe: string }) => {
        const w = window as unknown as { __VISUAL_FIXTURE_SEEDED__?: string[] };
        const text = document.body ? document.body.innerText : '';
        // No absent / loading / handled-error marker may be visible.
        if (arg.forbid.some((m) => text.includes(m))) return false;
        // The route's OWN contracted content must have rendered.
        if (arg.headingRe) {
          const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role=heading]'))
            .map((h) => (h.textContent || '').trim())
            .filter((h) => h.length >= 2);
          if (!headings.some((h) => new RegExp(arg.headingRe).test(h))) return false;
        }
        if (arg.textRe && !new RegExp(arg.textRe).test(text)) return false;
        if (text.trim().length <= arg.minBody) return false;
        if (arg.want.length === 0) return true;
        const seeded = (w.__VISUAL_FIXTURE_SEEDED__ || []).map((e) => {
          const raw = String(e).replace(/^[A-Za-z]+ /, '');
          try { return new URL(raw, location.origin).pathname; } catch { return raw.split('?')[0]; }
        });
        return arg.want.some((p) => seeded.includes(p));
      },
      { want, forbid, minBody, headingRe, textRe },
      { timeout: READY_TIMEOUT_MS, polling: 100 },
    )
    .then(() => true)
    .catch((err: unknown) => {
      // Preserve the real rejection (a readiness timeout OR a runtime/serialization
      // error) instead of discarding it — see the round-21b note above.
      waitError = err instanceof Error ? err.message : String(err);
      return false;
    });
  await settleFontsRaf(page);

  if (!ok) {
    const blank = {
      seededPaths: [] as string[],
      headings: [] as string[],
      bodyLen: 0,
      bodyHead: '',
      forbiddenPresent: [] as string[],
      headingMatched: null as string | null,
      headingError: null as string | null,
      textReMatched: true,
      textReError: null as string | null,
      minBodyOk: false,
    };
    const last = await page
      .evaluate(
        (arg: { want: string[]; forbid: string[]; minBody: number; headingRe: string; textRe: string }) => {
          const w = window as unknown as { __VISUAL_FIXTURE_SEEDED__?: string[] };
          const text = document.body ? document.body.innerText : '';
          const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role=heading]'))
            .map((h) => (h.textContent || '').trim())
            .filter((h) => h.length >= 2);
          const seededPaths = (w.__VISUAL_FIXTURE_SEEDED__ || []).map((e) => {
            const raw = String(e).replace(/^[A-Za-z]+ /, '');
            try { return new URL(raw, location.origin).pathname; } catch { return raw.split('?')[0] || ''; }
          });
          // FULL-body forbidden scan (mirrors the predicate's whole-body check).
          const forbiddenPresent = arg.forbid.filter((m) => text.includes(m));
          let headingMatched: string | null = null;
          let headingError: string | null = null;
          if (arg.headingRe) {
            try {
              for (const h of headings) { if (new RegExp(arg.headingRe).test(h)) { headingMatched = h; break; } }
            } catch (e) { headingError = e instanceof Error ? e.message : String(e); }
          }
          let textReMatched = true;
          let textReError: string | null = null;
          if (arg.textRe) {
            try { textReMatched = new RegExp(arg.textRe).test(text); }
            catch (e) { textReError = e instanceof Error ? e.message : String(e); }
          }
          return {
            seededPaths: seededPaths.slice(-64),
            headings: headings.slice(0, 12),
            bodyLen: text.trim().length,
            bodyHead: text.trim().slice(0, 240),
            forbiddenPresent,
            headingMatched,
            headingError,
            textReMatched,
            textReError,
            minBodyOk: text.trim().length > arg.minBody,
          };
        },
        { want, forbid, minBody, headingRe, textRe },
      )
      .catch(() => blank);
    const missingOwnEndpoints = want.filter((w) => !last.seededPaths.some((s) => pathOnly(s) === w));
    throw new Error(
      `route readiness did not settle within ${READY_TIMEOUT_MS}ms for ${routePath}: ` +
        `waitError=${JSON.stringify(waitError)} ` +
        `missingOwnEndpoints=${JSON.stringify(missingOwnEndpoints)} ` +
        `seeded=${JSON.stringify(last.seededPaths.map((s) => pathOnly(s)))} ` +
        `forbiddenPresent=${JSON.stringify(last.forbiddenPresent)} ` +
        `headingRe=${JSON.stringify(cfg.headingRe)} headingMatched=${JSON.stringify(last.headingMatched)} headingError=${JSON.stringify(last.headingError)} ` +
        `textRe=${JSON.stringify(cfg.textRe)} textReMatched=${last.textReMatched} textReError=${JSON.stringify(last.textReError)} ` +
        `minBodyChars=${minBody} minBodyOk=${last.minBodyOk} bodyLen=${last.bodyLen} ` +
        `headings=${JSON.stringify(last.headings)} bodyHead=${JSON.stringify(last.bodyHead)}`,
    );
  }
}

/**
 * Assert the route rendered its OWN expected content. Fail-closed on: shell
 * absence (unless the route is explicitly shellFree), any fixture gap, a
 * missing route-owned seeded endpoint (fixture identity), absent pinned visible
 * content, a forbidden loading/empty/error state, an unlisted PATHNAME
 * redirect, or a dropped meaningful query param. `cfgOverride` lets the adverse
 * safety tests exercise each failure mode with synthetic probes.
 */
export function assertContent(p: Probe, routePath: string, requested: string, cfgOverride?: Sentinel) {
  const cfg = cfgOverride ?? sentinelFor(routePath);
  // A shell-free route (the public planner form) is a real renderer that runs
  // outside the vNext shell; the precondition is skipped for it ONLY.
  if (!cfg.shellFree) {
    expect(p.root, `app shell root present for ${routePath}`).toBeTruthy();
  }
  // Unknown/empty success must fail: any fixture gap is a failure.
  expect(p.gaps, `fixture gaps for ${routePath}: ${JSON.stringify(p.gaps)}`).toHaveLength(0);

  // Route identity: every pinned route-owned endpoint MUST have been consumed.
  const consumed = new Set(p.seeded.map(pathOf));
  for (const want of cfg.ownEndpoints ?? []) {
    expect(
      consumed.has(pathOf(want)),
      `route ${routePath} must consume its OWN seeded endpoint ${want}; consumed=${JSON.stringify([...consumed])}`,
    ).toBeTruthy();
  }
  // A data route must consume at least one endpoint outside the shared shell
  // (defence in depth: ownEndpoints is authoritative, this catches an emptied
  // contract). A static-only route must instead pin its own rendered content.
  if (!cfg.staticOnly) {
    expect(ownSeeded(p.seeded).length, `route ${routePath} consumes only the shared shell — not its own content`).toBeGreaterThan(0);
  } else if (!cfg.headingRe && !cfg.textRe) {
    throw new Error(`static route ${routePath} pins no own static content (headingRe/textRe) — fail-closed`);
  }

  if (cfg.headingRe) {
    const real = p.headings.filter((h) => h.length >= 2);
    expect(real.some((h) => new RegExp(cfg.headingRe!).test(h)), `heading matching ${cfg.headingRe} for ${routePath} — headings=${JSON.stringify(p.headings)}`).toBeTruthy();
  }
  if (cfg.textRe) expect(p.bodyText).toMatch(new RegExp(cfg.textRe));

  // Absent / loading / empty / handled-error states are never baselines.
  for (const f of [...(cfg.forbid ?? []), ...FORBIDDEN_STATE_MARKERS]) {
    expect(p.bodyText, `forbidden state "${f}" present for ${routePath}`).not.toContain(f);
  }
  if (typeof cfg.minBodyChars === 'number') {
    expect(p.bodyLen, `substantial body text for ${routePath}`).toBeGreaterThan(cfg.minBodyChars);
  }

  // Redirect detection is PATHNAME based: a same-pathname landing is the app
  // canonicalizing the query string, never a redirect. A genuinely different
  // pathname requires the explicit allowed destination for the requested path.
  const landedPath = pathOnly(p.landed);
  const requestedPath = pathOnly(requested);
  if (landedPath !== requestedPath) {
    const allowed = sentinels.redirects?.[requested];
    if (!allowed) throw new Error(`unlisted redirect: requested ${requested} landed on ${p.landed}`);
    expect(norm(p.landed), `allowed redirect destination for ${requested}`).toBe(norm(allowed));
  } else {
    // Same pathname: every MEANINGFUL requested query param must survive the
    // app's default/query canonicalization, unless the sentinel explicitly
    // declares that param defaulted (cfg.queryDefaults). This keeps
    // selected-client / bill / tab / form-destination semantics enforced while
    // permitting the app to fill or drop genuinely-default params.
    const defaults = cfg.queryDefaults ?? {};
    const landedParams = new Map(queryPairs(p.landed));
    for (const [k, v] of queryPairs(requested)) {
      if (Object.hasOwn(defaults, k) && defaults[k] === v && !landedParams.has(k)) continue;
      expect(
        landedParams.get(k),
        `requested query ${k}=${v} must survive query canonicalization for ${routePath} (landed ${p.landed})`,
      ).toBe(v);
    }
  }
}

const captured = inventory.routes.filter((r: { coverage: string }) => r.coverage === 'captured');
const sentinelRedirectPaths = new Set(Object.keys(sentinels.redirects ?? {}));

/**
 * Bounded destination readiness for a redirect: wait until the browser's
 * pathname is the allowed destination (survives the client-side navigation that
 * destroys/creates execution contexts — waitForURL, not a fixed sleep).
 */
async function waitForRedirectDestination(page: Page, requested: string, destination: string): Promise<boolean> {
  const expectedPath = pathOnly(destination);
  const ok = await page
    .waitForURL(
      (url) => {
        const p = (url.pathname.split('?')[0] || '/').replace(/\/$/, '') || '/';
        return p === expectedPath;
      },
      { timeout: READY_TIMEOUT_MS, waitUntil: 'load' },
    )
    .then(() => true)
    .catch(() => false);
  return ok;
}

/**
 * Assert a requested path lands on the explicitly allowed destination, proving
 * the destination's EXISTING pinned content before an image may be taken.
 *
 * `filename` is the intended requested-route PNG (captured-route slug, or the
 * declared `redirect_` namespace). The destination + content-sentinel
 * provenance is recorded by the publisher; a navigation-only redirect proof is
 * NOT a baseline. `errors` carries the page-error observations for the
 * redirecting document.
 */
async function assertRedirect(page: Page, requested: string, destination: string, filename: string, errors: string[]) {
  const settled = await waitForRedirectDestination(page, requested, destination);
  await settleFontsRaf(page);
  const p = await probe(page);
  if (!settled) {
    throw new Error(
      `redirect ${requested} did not settle on ${pathOnly(destination)} within ${READY_TIMEOUT_MS}ms ` +
        `(landed ${p.landed}; bodyHead=${JSON.stringify(p.bodyText.trim().slice(0, 200))})`,
    );
  }
  expect(pathOnly(p.landed), `redirect destination for ${requested}`).not.toBe(pathOnly(requested));
  expect(pathOnly(p.landed), `allowed redirect destination for ${requested}`).toBe(pathOnly(destination));
  if (destination.includes('?')) expect(p.landed).toContain(destination.slice(destination.indexOf('?')));
  expect(p.gaps, `fixture gaps at redirect ${requested}`).toHaveLength(0);
  expect(p.root, `shell root present after redirect ${requested}`).toBeTruthy();

  // Additive harness fix: the DESTINATION must render its OWN EXISTING content
  // sentinel — exact destination key, else its pathname (e.g. /explorer?bill=…
  // binds the /explorer sentinel) — with bounded route-derived readiness and the
  // same forbidden absent/loading/error states. A blank/partial destination may
  // never establish a baseline. No new persona; routing is untouched.
  const sentinelKey = sentinelKeyForDestination(sentinels, destination);
  if (!sentinelKey) {
    throw new Error(`redirect ${requested} destination ${destination} has no content sentinel (generic fallback forbidden)`);
  }
  const cfg = sentinelFor(sentinelKey);
  await waitForRouteReady(page, cfg, sentinelKey);
  const dp = await probe(page);
  assertContent(dp, sentinelKey, sentinelKey);
  expect(dp.root, `shell root present at redirect destination ${destination}`).toBeTruthy();
  expect(errors, `page errors for redirect ${requested}: ${errors.slice(0, 3).join(' | ')}`).toHaveLength(0);

  // The screenshot belongs to the REQUESTED route. An ARRAY name is used so the
  // EXACT intended filename is preserved (a string name would have its
  // underscores sanitized to hyphens by Playwright 1.63).
  await expect(page).toHaveScreenshot([filename], {
    mask: [page.locator('[data-visual-mask]'), page.locator('.capiro-toast-region'), page.locator('time[datetime]')],
  });
}

for (const route of captured) {
  const target = route as { path: string };
  // A captured route observed to redirect at runtime is captured as a REDIRECT
  // (explicit destination), never as a page baseline.
  if (sentinelRedirectPaths.has(target.path)) {
    test(`redirect ${target.path}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
      await confine(page, target.path);
      await assertRedirect(page, target.path, sentinels.redirects[target.path], capturedRouteFilename(target.path), errors);
    });
    continue;
  }
  test(`route ${target.path}`, async ({ page }) => {
    // Resolve the explicit sentinel INSIDE the test so a missing contract fails
    // only this route (fail-closed), never the whole spec at collection time.
    const cfg = sentinelFor(target.path);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    await confine(page, target.path, { shellFree: cfg.shellFree });
    // Bounded, route-derived readiness BEFORE the single authoritative probe.
    await waitForRouteReady(page, cfg, target.path);
    const p = await probe(page);
    assertContent(p, target.path, target.path);
    expect(errors, `page errors for ${target.path}: ${errors.slice(0, 3).join(' | ')}`).toHaveLength(0);
    await expect(page).toHaveScreenshot([capturedRouteFilename(target.path)], {
      mask: [page.locator('[data-visual-mask]'), page.locator('.capiro-toast-region'), page.locator('time[datetime]')],
    });
  });
}

// Explicit redirect routes declared in the inventory. EVERY `redirect-recorded`
// route MUST get an explicit destination assertion AND its own
// `redirect_`-namespaced baseline PNG. The previous filter
// `!sentinelRedirectPaths.has(r.path)` silently dropped ALL of
// them — redirect-recorded paths are always present in sentinels.redirects
// (gen-route-sentinels copies them in), so 9 declared redirects had no test
// identity at all while the report counted "redirect 9→11". Captured routes
// observed to redirect are handled by the captured loop above.
const redirects = inventory.routes.filter(
  (r: { coverage: string; redirectTo?: string }) => r.coverage === 'redirect-recorded' && r.redirectTo,
);
for (const route of redirects) {
  const r = route as { path: string; redirectTo: string };
  test(`redirect ${r.path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    await confine(page, r.path);
    // Declared redirects use the explicit `redirect_` filename namespace so a
    // declared slug (e.g. /legiwatch/* → legiwatch) can never collide with a
    // captured route PNG (/legiwatch → legiwatch.png).
    await assertRedirect(page, r.path, r.redirectTo, declaredRedirectFilename(r.path), errors);
  });
}

/**
 * Independent offline-containment proof: an unrelated origin and a
 * cross-origin WebSocket must be denied, and service-worker registration must
 * be refused. This test is the deny probe the review asked for.
 */
test('offline containment: outbound + WebSocket + service worker denied', async ({ page }) => {
  const rec = await confine(page, '/');
  const outbound = await page.evaluate(async () => {
    const results: Array<{ target: string; blocked: boolean }> = [];
    for (const target of ['http://localhost.example/x', 'https://example.com/', 'http://127.0.0.1:9/other-port']) {
      try { await fetch(target, { mode: 'no-cors' }); results.push({ target, blocked: false }); }
      catch { results.push({ target, blocked: true }); }
    }
    return results;
  });
  for (const r of outbound) {
    expect(r.blocked, `outbound ${r.target} must be blocked`).toBeTruthy();
  }
  const swState = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false, controller: false, registerState: 'unsupported' };
    let registerState = 'unknown';
    try {
      const reg = await navigator.serviceWorker.register('/sw-probe.js');
      registerState = reg && reg.active ? 'active' : 'registered-inactive';
    } catch {
      registerState = 'rejected';
    }
    return { supported: true, controller: Boolean(navigator.serviceWorker.controller), registerState };
  });
  rec.swRegistrationDenied = !swState.controller && swState.registerState !== 'active';
  expect(swState.controller, 'no service worker may control the page').toBeFalsy();
  expect(swState.registerState, 'service worker must never activate').not.toBe('active');
  expect(page.context().serviceWorkers().length, 'no service worker may be running').toBe(0);
  expect(rec.blockedHttp.length, `blocked outbound requests recorded (${rec.blockedHttp.length})`).toBeGreaterThan(0);
});

/**
 * ADVERSE PROOF: the content sentinel must fail closed for the exact states the
 * round-4 review demanded — wrong-page/absent data, a shared-shell-only fetch, a
 * loading/empty/handled-error shell, a missing heading, a fixture gap, a static
 * route with no pinned content, and an unlisted redirect. These run against
 * synthetic probes (no browser) so they prove the ASSERTION, not the fixture.
 * Round-21 adds same-pathname query-contract and shellFree proofs.
 */
function makeProbe(over: Partial<Probe> & { seeded?: string[]; bodyText?: string; headings?: string[] }): Probe {
  const bodyText = over.bodyText ?? 'Real route content rendered with headings and data.';
  return {
    requested: over.requested ?? '/x',
    landed: over.landed ?? '/x',
    root: over.root ?? true,
    headings: over.headings ?? ['Expected Heading'],
    bodyText,
    bodyLen: over.bodyLen ?? bodyText.length,
    gaps: over.gaps ?? [],
    seeded: over.seeded ?? ['GET /api/intelligence/actions'],
    hits: over.hits ?? [],
    swController: false,
  };
}

const DATA_CFG: Sentinel = { ownEndpoints: ['/api/intelligence/actions'], staticOnly: false, headingRe: 'Expected Heading', forbid: [...FORBIDDEN_STATE_MARKERS], minBodyChars: 10 };
const STATIC_CFG: Sentinel = { ownEndpoints: [], staticOnly: true, headingRe: 'Help', forbid: [...FORBIDDEN_STATE_MARKERS], minBodyChars: 10 };

test('safety: wrong/absent route data (own endpoint not consumed) fails', () => {
  const p = makeProbe({ seeded: ['GET /api/me', 'GET /api/clients'] }); // shared shell only
  expect(() => assertContent(p, '/x', '/x', DATA_CFG)).toThrow();
});

test('safety: shared-shell-only fetch cannot qualify as a data sentinel', () => {
  const p = makeProbe({ seeded: ['GET /api/me', 'GET /api/notifications'] });
  // A DATA route (staticOnly:false) whose ownEndpoints were emptied must still
  // fail when the probe consumed only shared-shell endpoints (defence in depth).
  expect(() => assertContent(p, '/x', '/x', { ...DATA_CFG, ownEndpoints: [] })).toThrow();
});

test('safety: loading/empty/handled-error shell fails', () => {
  const p = makeProbe({ bodyText: 'Loading…', bodyLen: 120, seeded: ['GET /api/intelligence/actions'] });
  expect(() => assertContent(p, '/x', '/x', DATA_CFG)).toThrow();
  const p2 = makeProbe({ bodyText: 'Something went wrong. Please retry.', bodyLen: 120, seeded: ['GET /api/intelligence/actions'] });
  expect(() => assertContent(p2, '/x', '/x', DATA_CFG)).toThrow();
});

test('safety: missing expected heading fails', () => {
  const p = makeProbe({ headings: ['Some Other Page'], seeded: ['GET /api/intelligence/actions'] });
  expect(() => assertContent(p, '/x', '/x', DATA_CFG)).toThrow();
});

test('safety: fixture gap fails even with a seeded own endpoint', () => {
  const p = makeProbe({ gaps: [{ url: '/api/unknown', method: 'get', status: 'unseeded' }], seeded: ['GET /api/intelligence/actions'] });
  expect(() => assertContent(p, '/x', '/x', DATA_CFG)).toThrow();
});

test('safety: static route with no pinned content fails closed', () => {
  const p = makeProbe({ seeded: ['GET /api/me'] });
  expect(() => assertContent(p, '/x', '/x', { ownEndpoints: [], staticOnly: true, forbid: [...FORBIDDEN_STATE_MARKERS], minBodyChars: 10 })).toThrow();
});

test('safety: unlisted redirect fails', () => {
  const p = makeProbe({ requested: '/x', landed: '/somewhere-else', seeded: ['GET /api/intelligence/actions'] });
  expect(() => assertContent(p, '/x', '/x', DATA_CFG)).toThrow();
});

test('safety: a correct data-backed render passes', () => {
  const p = makeProbe({ seeded: ['GET /api/me', 'GET /api/intelligence/actions'], headings: ['Expected Heading'], bodyText: 'Expected Heading with real data rows.' });
  expect(() => assertContent(p, '/x', '/x', DATA_CFG)).not.toThrow();
});

// ── Round-21: same-pathname query canonicalization contract ─────────────────
test('safety: same-pathname query canonicalization is NOT a redirect', () => {
  // The app fills a default param (tab=contracts) and keeps the meaningful one.
  const p = makeProbe({ requested: '/federal-spending', landed: '/federal-spending?tab=contracts', seeded: ['GET /api/intelligence/actions'] });
  expect(() => assertContent(p, '/x', '/federal-spending', DATA_CFG)).not.toThrow();
});

test('safety: a dropped MEANINGFUL requested query param fails', () => {
  // The requested tab=hearings silently vanished: a real contract regression.
  const p = makeProbe({ requested: '/legiwatch?tab=hearings', landed: '/legiwatch', seeded: ['GET /api/intelligence/actions'] });
  expect(() => assertContent(p, '/x', '/legiwatch?tab=hearings', DATA_CFG)).toThrow();
});

test('safety: a declared default query param may be canonicalized away', () => {
  const p = makeProbe({ requested: '/engagement/reports?period=current', landed: '/engagement/reports', seeded: ['GET /api/intelligence/actions'] });
  expect(() => assertContent(p, '/x', '/engagement/reports?period=current', { ...DATA_CFG, queryDefaults: { period: 'current' } })).not.toThrow();
});

test('safety: only the exact declared default query value may disappear', () => {
  const p = makeProbe({ requested: '/engagement/reports?period=previous', landed: '/engagement/reports', seeded: ['GET /api/intelligence/actions'] });
  expect(() => assertContent(p, '/x', '/engagement/reports?period=previous', { ...DATA_CFG, queryDefaults: { period: 'current' } })).toThrow();
});

test('safety: a declared default cannot change to a different landed query value', () => {
  const p = makeProbe({ requested: '/engagement/reports?period=current', landed: '/engagement/reports?period=previous', seeded: ['GET /api/intelligence/actions'] });
  expect(() => assertContent(p, '/x', '/engagement/reports?period=current', { ...DATA_CFG, queryDefaults: { period: 'current' } })).toThrow();
});

// ── Round-21: shell-free contract ───────────────────────────────────────────
test('safety: shell-free route passes without a shell root but still requires own data', () => {
  const ok = makeProbe({
    root: false,
    requested: '/planner/forms/visual-planner-token',
    landed: '/planner/forms/visual-planner-token',
    headings: ['Planner intake form'],
    bodyText: 'Planner intake form Synthetic public form for offline route capture.',
    seeded: ['get http://127.0.0.1:4190/strategy-api/planner/public/forms/visual-planner-token'],
  });
  const cfg: Sentinel = {
    ownEndpoints: ['http://127.0.0.1:4190/strategy-api/planner/public/forms/visual-planner-token'],
    staticOnly: false,
    shellFree: true,
    headingRe: 'Planner intake form',
    forbid: [...FORBIDDEN_STATE_MARKERS],
    minBodyChars: 10,
  };
  expect(() => assertContent(ok, '/planner/forms/visual-planner-token', '/planner/forms/visual-planner-token', cfg)).not.toThrow();
  // The own-endpoint identity assertion still applies on a shell-free route.
  const bad = makeProbe({ root: false, requested: '/planner/forms/visual-planner-token', landed: '/planner/forms/visual-planner-token', seeded: ['get /api/me'] });
  expect(() => assertContent(bad, '/planner/forms/visual-planner-token', '/planner/forms/visual-planner-token', cfg)).toThrow();
});

// ── Round-21: shellFree is opt-in, never a silent shell bypass ──────────────
test('safety: a non-shellFree route still fails without the shell root', () => {
  const p = makeProbe({ root: false, seeded: ['GET /api/intelligence/actions'] });
  expect(() => assertContent(p, '/x', '/x', DATA_CFG)).toThrow();
});

export { OWNED_ORIGIN, OWNED_WS, SHARED_SHELL, STATIC_CFG };
