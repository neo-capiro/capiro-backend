import { test, expect, type Page } from '../lib/playwright-bridge.mjs';
import { SHARED_SHELL_ENDPOINTS, FORBIDDEN_STATE_MARKERS } from '../lib/projects.mjs';
import { recordRenderObservation } from '../lib/render-context.mjs';

/**
 * Workspace / onboarding smoke (CleanUp1 §8.2). This is IN ADDITION to the
 * per-route baselines, and asserts real, data-backed content with no fixture
 * gaps, no page errors and no loading/absent state — not a nav-only shell.
 *
 * The onboarding entry redirects (observed in the strict discovery pass) to the
 * authenticated root; that redirect destination is asserted explicitly rather
 * than pretending the URL is a standalone page.
 */

const FIXED_CLOCK = '2026-10-07T12:00:00.000Z';
const BASE = process.env.CAPIRO_VISUAL_BASE_URL || 'http://127.0.0.1:4190';
const OWNED_ORIGIN = new URL(BASE).origin;
const SHARED = new Set<string>(SHARED_SHELL_ENDPOINTS);

const KILL_MOTION = `(() => { const apply = () => { const r = document.head || document.documentElement; if (!r) return; const s = document.createElement('style'); s.textContent='*,*::before,*::after{animation:none!important;transition:none!important}'; r.appendChild(s); }; apply(); if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',apply,{once:true}); })();`;

// Actual render-context observation (round 73) — see routes.spec.ts.
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

type SmokeProbe = { landed: string; root: boolean; bodyText: string; bodyLen: number; gaps: Array<{ url: string; method: string }>; seeded: string[] };

async function open(
  page: Page,
  url: string,
  ready?: (page: Page) => Promise<void>,
): Promise<{ probe: SmokeProbe; errors: string[] }> {
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
  await page.clock.setFixedTime(new Date(FIXED_CLOCK));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(document.querySelector('.capiro-vnext-root')), null, { timeout: 45_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  // Bounded, route-specific content readiness. Shell + fonts + two rAFs only
  // prove the shell painted; a lazy route chunk (e.g. the Hill Day wizard) mounts
  // its real first-step content asynchronously afterwards. When supplied this wait
  // is ENFORCED (never swallowed) so the probe cannot sample a shell-only,
  // still-loading frame. It polls a real DOM predicate — no sleeps, no networkidle.
  if (ready) await ready(page);
  const probe = await page.evaluate(() => {
    const w = window as unknown as { __VISUAL_FIXTURE_GAPS__?: Array<{ url: string; method: string }>; __VISUAL_FIXTURE_SEEDED__?: string[] };
    return {
      landed: location.pathname + location.search,
      root: Boolean(document.querySelector('.capiro-vnext-root')),
      bodyText: document.body?.innerText || '',
      bodyLen: (document.body?.innerText || '').trim().length,
      gaps: w.__VISUAL_FIXTURE_GAPS__ || [],
      seeded: w.__VISUAL_FIXTURE_SEEDED__ || [],
    };
  });
  // Record the ACTUAL page context of the page this test captured.
  await recordContext(page);
  return { probe, errors };
}

/**
 * Real first-step readiness for /workspace/documents/new (Hill Day wizard).
 * The wizard is a lazy chunk, so the shell can paint — and the probe run — before
 * it mounts. Wait for the step-0 heading the source renders ("What are you
 * making?", HillDayWizard step 1) AND the template pick-card control the user
 * acts on, so the probe samples the real first step rather than the shell's
 * `Loading…` placeholder. Real source selectors; no sleep, no networkidle.
 */
async function waitForFirstWizardStep(page: Page) {
  await page.waitForFunction(
    () => {
      const heading = document.querySelector('.hd-step-heading');
      if (!heading || !/what are you making\?/i.test(heading.textContent || '')) return false;
      return Boolean(document.querySelector('.hd-pick-grid .hd-pick-card'));
    },
    null,
    { timeout: 45_000 },
  );
}

/**
 * Real readiness for /workspace/documents (Hill Day document library).
 * The library is a lazy route chunk that fires its OWN data query
 * (`api.listDocuments` → GET /workspace-api/hillday/documents,
 * Page<LibraryRow>) AFTER the shell paints, so the plain probe could sample a
 * shell-only frame whose seeded requests are all shared-shell — losing the
 * route's own-data evidence. Wait for BOTH:
 *   - the library's OWN request evidence recorded by the fixture client
 *     (`get /workspace-api/hillday/documents` on window.__VISUAL_FIXTURE_SEEDED__;
 *     source: src/vnext/pages/workspace/hillday/api.ts listDocuments), and
 *   - the real data-backed row the source renders for a seeded document — the
 *     source maps rows to `<button class="hd-doc-table__row">` carrying a
 *     `.hd-doc-table__name` (the empty/error branches render a non-button div,
 *     so a button row is genuinely data-backed content, never a shell placeholder).
 * Real source selectors/endpoint; no sleep, no networkidle, no retries.
 */
async function waitForDocumentLibrary(page: Page) {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __VISUAL_FIXTURE_SEEDED__?: string[] };
      const seeded = w.__VISUAL_FIXTURE_SEEDED__ || [];
      if (!seeded.some((s) => s.includes('/workspace-api/hillday/documents'))) return false;
      const name = document.querySelector('button.hd-doc-table__row .hd-doc-table__name');
      return Boolean(name && (name.textContent || '').trim().length > 0);
    },
    null,
    { timeout: 45_000 },
  );
}

function assertClean(probe: SmokeProbe, routePath: string, errors: string[]) {
  expect(probe.root, `shell root for ${routePath}`).toBeTruthy();
  expect(probe.gaps, `fixture gaps for ${routePath}: ${JSON.stringify(probe.gaps)}`).toHaveLength(0);
  for (const f of FORBIDDEN_STATE_MARKERS) {
    expect(probe.bodyText, `forbidden state "${f}" for ${routePath}`).not.toContain(f);
  }
  expect(errors, `page errors for ${routePath}: ${errors.slice(0, 3).join(' | ')}`).toHaveLength(0);
  const own = probe.seeded.map((s) => (s.replace(/^[A-Za-z]+ /, '').split('?')[0] ?? '')).filter((p) => !SHARED.has(p));
  expect(own.length, `route ${routePath} must consume its own data (outside the shared shell); seeded=${JSON.stringify(probe.seeded)}`).toBeGreaterThan(0);
}

test('workspace: document library renders real data-backed content', async ({ page }) => {
  const { probe, errors } = await open(page, `${BASE}/workspace/documents`, waitForDocumentLibrary);
  assertClean(probe, '/workspace/documents', errors);
  expect(probe.bodyLen, 'substantial workspace body').toBeGreaterThan(120);
  await expect(page.getByRole('heading').first()).toBeVisible();
});

test('workspace: new-document wizard opens a real first step', async ({ page }) => {
  const { probe, errors } = await open(page, `${BASE}/workspace/documents/new`, waitForFirstWizardStep);
  expect(probe.root, 'shell root').toBeTruthy();
  expect(probe.gaps, `fixture gaps: ${JSON.stringify(probe.gaps)}`).toHaveLength(0);
  for (const f of FORBIDDEN_STATE_MARKERS) expect(probe.bodyText).not.toContain(f);
  expect(probe.bodyLen, 'substantial wizard body').toBeGreaterThan(80);
  expect(errors, `page errors: ${errors.slice(0, 3).join(' | ')}`).toHaveLength(0);
  // Strengthened content evidence: the real first step (source: HillDayWizard
  // step 1) is what rendered — its heading and template control are on screen,
  // not a shell/loading frame.
  await expect(
    page.locator('.hd-step-heading', { hasText: 'What are you making?' }),
  ).toBeVisible();
  await expect(page.locator('.hd-pick-grid .hd-pick-card').first()).toBeVisible();
  await expect(page.getByRole('heading').first()).toBeVisible();
});

test('onboarding: subscribe entry resolves to the authenticated surface', async ({ page }) => {
  const { probe, errors } = await open(page, `${BASE}/onboarding/subscribe`);
  // Observed in the strict discovery pass: /onboarding/subscribe redirects to '/'.
  expect(probe.landed.split('?')[0], 'onboarding/subscribe redirect destination').toBe('/');
  expect(probe.root, 'shell root after onboarding redirect').toBeTruthy();
  expect(probe.gaps, `fixture gaps at onboarding entry: ${JSON.stringify(probe.gaps)}`).toHaveLength(0);
  expect(errors, `page errors at onboarding entry: ${errors.slice(0, 3).join(' | ')}`).toHaveLength(0);
  expect(probe.bodyLen, 'substantial onboarding body').toBeGreaterThan(80);
});
