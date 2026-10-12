import { test, expect, type Page } from '../lib/playwright-bridge.mjs';
import path from 'node:path';
import { recordRenderObservation } from '../lib/render-context.mjs';

/**
 * CONDITIONAL-page coverage (visual review round 7).
 *
 * A conditional page has MORE than one reachable branch. Picking the default
 * (dormant) fixture and pinning only the redirect ERASES the active branch. This
 * spec proves BOTH branches of the two conditional routes the review called out,
 * WITHOUT ever erasing the default-state redirect proof and WITHOUT making any
 * checkout/payment call (`Continue to payment` is a mutation and stays
 * fail-closed in the fixture).
 *
 *   /onboarding/subscribe         default → navigate '/';  billing_enabled → the
 *                                 plan page (billingEnabled:true, status 'none')
 *   /intelligence/bills/:id       default → /explorer?bill=…  (Explorer fallback)
 *                                 bill360_enabled → /bills/:id  (Bill 360 branch)
 *   /bills/:id                    bill360_enabled → the enabled dossier page
 *
 * The active branch is selected by window.__VISUAL_FIXTURE_PERSONA__, set here
 * via addInitScript before navigation (never by mutating the default fixture).
 */

const BASE = process.env.CAPIRO_VISUAL_BASE_URL || 'http://127.0.0.1:4190';
const OWNED = new URL(BASE);
const OWNED_ORIGIN = OWNED.origin;
const OWNED_WS = `ws://${OWNED.host}`;
const FIXED_CLOCK = '2026-10-07T12:00:00.000Z';

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

// Actual render-context observation (round 73) — see routes.spec.ts. Records the
// REAL page context of every conditional capture page.
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

async function confine(page: Page, persona?: string) {
  await page.route('**/*', async (r) => {
    let url: URL;
    try { url = new URL(r.request().url()); } catch { await r.abort('blockedbyclient'); return; }
    const scheme = url.protocol;
    if (scheme === 'data:' || scheme === 'blob:' || scheme === 'about:') return r.continue();
    if ((scheme === 'http:' || scheme === 'https:') && url.origin === OWNED_ORIGIN) return r.continue();
    await r.abort('blockedbyclient');
  });
  await page.routeWebSocket(/.*/, (ws) => {
    try {
      const u = new URL(ws.url());
      if (u.protocol === 'ws:' && `${u.protocol}//${u.host}` === OWNED_WS) { ws.connectToServer(); return; }
    } catch { /* deny */ }
    ws.close({ code: 1008, reason: 'visual-offline-containment' });
  });
  if (persona) await page.addInitScript((p: string) => { (window as unknown as { __VISUAL_FIXTURE_PERSONA__?: string }).__VISUAL_FIXTURE_PERSONA__ = p; }, persona);
  await page.addInitScript(KILL_MOTION);
  await page.clock.setFixedTime(new Date(FIXED_CLOCK));
}

async function goto(page: Page, routePath: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  await page.goto(routePath, { waitUntil: 'load' });
  await page.waitForSelector('.capiro-vnext-root', { timeout: 45_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  // Record the ACTUAL page context of the page this test will capture.
  await recordContext(page);
  return errors;
}

/**
 * Bounded, semantic readiness for the enabled Bill 360 dossier.
 *
 * `goto()` only proves the shared shell painted — the shell's own `Loading…`
 * placeholder satisfies it. The dossier leaf is a lazy route whose body runs an
 * async query: until it resolves, BillDossierBodyVNext renders the real loading
 * region (`.b360-loading[aria-label="Loading bill dossier"]`) and the probe would
 * sample shell-only text (observed on tablet-1024: nav + `Loading…`, no title).
 * Wait ENFORCED (never swallowed) for the actual leaf content the downstream
 * assertions require — the hero title (`.b360-hero .b360-title`) and the 6-cell
 * KPI strip (`.b360-kpi-strip`) — using the component's own selectors, and for
 * the loading placeholder to be gone. Polls a real DOM predicate: no sleep, no
 * networkidle, and the frozen clock / offline containment stay untouched.
 */
async function waitForDossierContent(page: Page) {
  await page.waitForFunction(
    () => {
      const dossier = document.querySelector('.b360-dossier');
      if (!dossier) return false;
      if (dossier.querySelector('[aria-label="Loading bill dossier"]')) return false;
      const title = dossier.querySelector('.b360-hero .b360-title');
      if (!title || !(title.textContent || '').trim()) return false;
      return Boolean(dossier.querySelector('.b360-kpi-strip'));
    },
    null,
    { timeout: 45_000 },
  );
}

function pathOnly(s: string): string {
  return (s.split('?')[0] || '/').replace(/\/$/, '') || '/';
}

const SUBSCRIBE = '/onboarding/subscribe';

test(`conditional: ${SUBSCRIBE} renders the enabled plan page (billing_enabled)`, async ({ page }) => {
  await confine(page, 'billing_enabled');
  const errors = await goto(page, SUBSCRIBE);
  const p = await page.evaluate(() => {
    const w = window as unknown as { __VISUAL_FIXTURE_GAPS__?: unknown[]; __VISUAL_FIXTURE_HITS__?: string[] };
    return {
      landed: location.pathname + location.search,
      headings: Array.from(document.querySelectorAll('h1,h2,h3')).map((h) => (h.textContent || '').trim()),
      bodyText: document.body?.innerText || '',
      gaps: w.__VISUAL_FIXTURE_GAPS__ || [],
      hits: w.__VISUAL_FIXTURE_HITS__ || [],
    };
  });
  // Active branch: stays on the page (the dormant branch leaves to '/').
  expect(pathOnly(p.landed), 'billing-enabled subscribe does not leave the page').toBe(SUBSCRIBE);
  expect(p.gaps, `fixture gaps: ${JSON.stringify(p.gaps)}`).toHaveLength(0);
  expect(errors, `page errors: ${errors.slice(0, 3).join(' | ')}`).toHaveLength(0);
  expect(p.headings.some((h) => /Welcome to Capiro/i.test(h)), `plan heading present; headings=${JSON.stringify(p.headings)}`).toBeTruthy();
  expect(p.hits.some((h) => pathOnly(h.replace(/^[A-Za-z]+ /, '')) === '/api/billing/summary'), 'consumed the billing endpoint SubscribePage reads').toBeTruthy();
  // No checkout affordance was exercised: the mutation never fires.
  expect(p.hits.some((h) => /checkout|payment|stripe/i.test(h)), 'no checkout/payment call').toBeFalsy();
  await expect(page).toHaveScreenshot(['conditional_onboarding_subscribe_billing_enabled.png'], {
    mask: [page.locator('[data-visual-mask]'), page.locator('.capiro-toast-region'), page.locator('time[datetime]')],
  });
});

test(`conditional: ${SUBSCRIBE} default persona still leaves to / (dormant branch preserved)`, async ({ page }) => {
  await confine(page);
  await goto(page, SUBSCRIBE);
  const landed = await page.evaluate(() => location.pathname);
  expect(pathOnly(landed), 'dormant/entitled redirect preserved').toBe('/');
});

test('conditional: /intelligence/bills/hr-2027-1234 default → Explorer fallback', async ({ page }) => {
  await confine(page);
  await goto(page, '/intelligence/bills/hr-2027-1234');
  const landed = await page.evaluate(() => location.pathname + location.search);
  expect(pathOnly(landed), 'Explorer fallback preserved').toBe('/explorer');
});

// NOTE (readiness branch): useBillTarget returns the LEGACY target while the
// bill_360 flag is unresolved — a redirect fires once and cannot be taken back —
// so the leaf deliberately lands on Explorer on a cold flag. The ENABLED branch
// is therefore proven at its own address (/bills/:id, below), not by racing the
// leaf redirect, which the current source does not guarantee.

test('conditional: /bills/hr-2027-1234 bill360_enabled renders the enabled dossier page', async ({ page }) => {
  await confine(page, 'bill360_enabled');
  const errors = await goto(page, '/bills/hr-2027-1234');
  // Wait (enforced) for the asynchronous dossier leaf content before probing:
  // shell readiness alone samples the still-loading body and misses the title.
  await waitForDossierContent(page);
  const p = await page.evaluate(() => {
    const w = window as unknown as { __VISUAL_FIXTURE_GAPS__?: unknown[]; __VISUAL_FIXTURE_HITS__?: string[] };
    return {
      landed: location.pathname,
      bodyText: document.body?.innerText || '',
      gaps: w.__VISUAL_FIXTURE_GAPS__ || [],
      hits: w.__VISUAL_FIXTURE_HITS__ || [],
      hasDossierClass: Boolean(document.querySelector('.b360-route .b360-dossier, .b360-dossier')),
    };
  });
  expect(pathOnly(p.landed), 'stays on the Bill 360 page').toBe('/bills/hr-2027-1234');
  expect(p.gaps, `fixture gaps: ${JSON.stringify(p.gaps)}`).toHaveLength(0);
  expect(errors, `page errors: ${errors.slice(0, 3).join(' | ')}`).toHaveLength(0);
  // Enabled branch renders the real dossier (bill identity + KPI content), never
  // the not-enabled empty state.
  expect(p.bodyText, 'dossier bill identity rendered').toMatch(/Visual Fixture Defense Appropriations Act, 2027/);
  expect(p.bodyText, 'dossier KPI content rendered').toMatch(/recorded an expected next milestone/i);
  expect(p.bodyText, 'not-enabled state must not be the baseline').not.toMatch(/Bill 360 is not enabled/i);
  expect(p.hits.some((h) => pathOnly(h.replace(/^[A-Za-z]+ /, '')) === '/intel-api/bills/hr-2027-1234/dossier'), 'consumed the dossier endpoint').toBeTruthy();
  expect(p.hasDossierClass, 'dossier body rendered').toBeTruthy();
  await expect(page).toHaveScreenshot(['conditional_bills_bill360_enabled.png'], {
    mask: [page.locator('[data-visual-mask]'), page.locator('.capiro-toast-region'), page.locator('time[datetime]')],
  });
});
