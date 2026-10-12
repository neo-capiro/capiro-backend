import { test, expect, type Page } from '../lib/playwright-bridge.mjs';
import { FORBIDDEN_STATE_MARKERS } from '../lib/projects.mjs';
import { recordRenderObservation } from '../lib/render-context.mjs';

/**
 * apps/onboard-web native smoke (round-14) — the SEPARATE rendered frontend.
 *
 * Asserts REAL, path-specific visible content on the onboard-web funnel (served
 * by smoke/vite.onboard-smoke.config.ts with a signed-out Clerk stub + a
 * controlled /onboard-api/public/config fixture). This is NOT the apps/web
 * /onboarding/subscribe redirect — that surface is asserted elsewhere and is not
 * this app.
 */

const BASE = process.env.CAPIRO_ONBOARD_SMOKE_URL || 'http://127.0.0.1:4192';
const OWNED_ORIGIN = new URL(BASE).origin;
// The SAME fixed clock the route captures apply (projects.mjs FIXED_CLOCK_ISO):
// the separate onboarding page context is part of the ONE render-context
// contract, so the onboarding page must render on the ACTUAL applied fixed clock
// or its observed fixedClock would disagree with the route clock and the
// producer would (correctly) refuse.
const FIXED_CLOCK = '2026-10-07T12:00:00.000Z';

const KILL_MOTION = `(() => { const apply = () => { const r = document.head || document.documentElement; if (!r) return; const s = document.createElement('style'); s.textContent='*,*::before,*::after{animation:none!important;transition:none!important}'; r.appendChild(s); }; apply(); if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',apply,{once:true}); })();`;

type Probe = { url: string; bodyText: string; bodyLen: number };

// Actual render-context observation (round 73): the SEPARATE onboarding page
// context is recorded independently of the route captures.
const OBS_FILE = process.env.CAPIRO_RENDER_OBSERVATIONS || '';
const OBS_PHASE = process.env.CAPIRO_RENDER_PHASE || 'onboard-smoke';
async function recordContext(page: Page): Promise<void> {
  // Plain runs (no producer-supplied observation path) record nothing: a no-op.
  // When the producer DID supply a path, a recording failure must FAIL this test
  // (fail closed): swallowing it could silently drop the onboarding page's
  // observation while the route pages already recorded each project, so
  // aggregation could still "succeed" on an incomplete set. (root review round 80)
  if (!OBS_FILE) return;
  const recorded = await recordRenderObservation({ file: OBS_FILE, phase: OBS_PHASE, project: test.info().project.name, page });
  if (recorded !== true) throw new Error(`render-context observation was not recorded for ${test.info().project.name}`);
}

async function open(page: Page, routePath: string): Promise<{ probe: Probe; errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  await page.route('**/*', async (r) => {
    let u: URL;
    try { u = new URL(r.request().url()); } catch { return r.abort('blockedbyclient'); }
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return r.continue();
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === OWNED_ORIGIN) return r.continue();
    return r.abort('blockedbyclient');
  });
  await page.addInitScript(KILL_MOTION);
  // Apply the fixed clock (same semantics as the route specs: fixed time, not a
  // paused clock / Date subclass) BEFORE navigation, so the onboarding page's
  // actual page context — including its clock — is observed coherently.
  await page.clock.setFixedTime(new Date(FIXED_CLOCK));
  await page.goto(`${BASE}${routePath}`, { waitUntil: 'load' });
  // Fail-closed: a root that never renders (timeout) must FAIL the test rather
  // than be swallowed by a `.catch` that turns it into a passing probe. The
  // fonts + two-RAF waits below propagate for the same reason.
  await page.waitForFunction(
    () => (document.getElementById('root')?.textContent || '').trim().length > 0,
    null,
    { timeout: 45_000 },
  );
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  const probe = await page.evaluate(() => ({
    url: location.pathname,
    bodyText: document.body?.innerText || '',
    bodyLen: (document.body?.innerText || '').trim().length,
  }));
  // Record the ACTUAL page context of the onboarding page this test captured.
  await recordContext(page);
  return { probe, errors };
}

test('onboard-web /register renders the real purchaser registration form', async ({ page }) => {
  const { probe, errors } = await open(page, '/register');
  expect(probe.url, 'onboard-web /register path').toBe('/register');
  expect(errors, `page errors: ${errors.slice(0, 3).join(' | ')}`).toHaveLength(0);
  for (const f of FORBIDDEN_STATE_MARKERS) expect(probe.bodyText, `forbidden state "${f}"`).not.toContain(f);
  // Path-specific, data-backed content owned by onboard-web's RegisterPage.
  // The kicker renders with `text-transform: uppercase` (ui/primitives
  // ScreenTitle), so a case-sensitive body.innerText substring is the wrong
  // assertion for it. Assert the kicker (and the h1) with VISIBLE, anchored
  // locators matched against source text / accessible name — insensitive to the
  // CSS transform — while keeping the pinned content identical.
  await expect(page.getByText('Create your organization', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: "Let's get your firm set up", exact: true })).toBeVisible();
  // Field labels and the submit button carry no text-transform; their pinned
  // innerText stays mixed-case.
  expect(probe.bodyText).toContain('Work email');
  expect(probe.bodyText).toContain('Organization name');
  expect(probe.bodyText).toContain('Create Account');
  expect(probe.bodyLen, 'substantial register body').toBeGreaterThan(200);
  await expect(page.getByRole('button', { name: 'Create Account' })).toBeVisible();
});

test('onboard-web unknown signed-out route redirects to /register', async ({ page }) => {
  const { probe, errors } = await open(page, '/definitely-not-an-onboard-route');
  expect(errors, `page errors: ${errors.slice(0, 3).join(' | ')}`).toHaveLength(0);
  expect(probe.url, 'signed-out unknown path redirects to /register').toBe('/register');
  expect(probe.bodyText).toContain("Let's get your firm set up");
});
