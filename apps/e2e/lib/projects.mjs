/**
 * Capture projects — the exact plan determinism contract (CleanUp1 §8.2).
 *
 * One Chromium project per viewport. Firefox/WebKit are deliberately omitted:
 * Chromium matches the existing CDP harness the captures are compared against,
 * and keeps CI cost down. They can be added later as opt-in projects.
 *
 * Every value here is part of the determinism contract; changing one changes
 * every baseline and must be a deliberate, reviewed baseline update.
 */
export const PROJECTS = Object.freeze([
  { name: 'desktop-1440', viewport: { width: 1440, height: 1000 } },
  { name: 'tablet-1024', viewport: { width: 1024, height: 1000 } },
  { name: 'mobile-390', viewport: { width: 390, height: 844 } },
]);

/**
 * The SEPARATE onboarding project (apps/onboard-web native smoke). Its viewport
 * is part of the render-context contract too: the onboarding page is a distinct
 * rendered surface and its page context must be observed independently. This is
 * the ONE source of truth both playwright.onboard.config.ts and the render
 * context aggregation consume (never a duplicated literal).
 */
export const ONBOARD_PROJECT = Object.freeze({
  name: 'onboard-desktop-1440',
  viewport: Object.freeze({ width: 1440, height: 1000 }),
});

/** Chromium launch flags that make a render byte-stable. */
export const CHROMIUM_ARGS = Object.freeze([
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  // A system proxy can intercept the loopback URL and land the tab on
  // chrome-error://chromewebdata (observed 2026-09-01 in the CDP harness).
  '--proxy-server=direct://',
  '--proxy-bypass-list=*',
]);

/** Fixed clock for every capture so relative timestamps are stable. */
export const FIXED_CLOCK_ISO = '2026-10-07T12:00:00.000Z';

export const LOCALE = 'en-US';
export const TIMEZONE = 'America/New_York';

/** Comparison policy (CleanUp1 §8.5). */
export const COMPARISON = Object.freeze({ maxDiffPixelRatio: 0.002, threshold: 0.2 });

/**
 * Volatile regions masked in every capture. These are regions whose pixels are
 * legitimately clock-, id- or data-derived and cannot be stabilised by the fixture
 * layer. Primary UI is never masked — see the mask rule in capture.mjs. Selectors
 * are resolved at capture time; absent selectors are ignored.
 */
export const MASK_SELECTORS = Object.freeze([
  '[data-visual-mask]',
  '.capiro-toast-region',
  '.capiro-vnext-uui__clock',
  'time[datetime]',
]);

export const NAV_TIMEOUT_MS = 45_000;

/**
 * Conditional-page screenshot obligations: the ACTIVE-branch captures produced
 * by tests/conditional.spec.ts. A whole-suite capture must produce one PNG per
 * obligation per project; a suite that silently stopped capturing them is a
 * failure, not a smaller publish. Single source of truth: imported by the
 * capture script AND the coverage guard.
 */
export const CONDITIONAL_SCREENSHOT_NAMES = Object.freeze([
  'conditional_onboarding_subscribe_billing_enabled',
  'conditional_bills_bill360_enabled',
]);

/**
 * Endpoints the always-present vNext shell fetches on EVERY route. A captured
 * route proves its OWN data-backed content only with a seeded request OUTSIDE
 * this set — a shared-shell-only fetch can never qualify as a route sentinel.
 * Single source of truth: imported by the capture spec AND the sentinel
 * generator.
 */
export const SHARED_SHELL_ENDPOINTS = Object.freeze([
  '/api/me',
  '/api/billing/state',
  '/api/billing/summary',
  '/api/me/broadcasts/pending',
  '/api/me/email-signature',
  '/api/notifications',
  '/api/clients',
  '/workspace-api/notifications',
  '/api/engagement/integrations',
  '/api/engagement/capabilities',
  '/onboard-api/setup/state',
  // Global overlay pollers: observed on 100% of clean routes in the strict
  // discovery pass (55/55) — they are shared shell, never a route's own data.
  '/api/business-development/alerts',
  '/api/legiwatch/live-hearings/notifications',
  '/strategy-api/planner/notifications',
  '/intel-api/feature-flags',
]);

/**
 * Substrings that mark an absent / loading / handled-error render. A captured
 * route whose visible text contains any of these is a failed content sentinel
 * (round-4: loading/skeleton/handled-error shells must not become baselines).
 */
export const FORBIDDEN_STATE_MARKERS = Object.freeze([
  'Loading…',
  'Loading...',
  'Something went wrong',
  'An unexpected error occurred',
  'This page could not be found',
  'Failed to load',
]);
