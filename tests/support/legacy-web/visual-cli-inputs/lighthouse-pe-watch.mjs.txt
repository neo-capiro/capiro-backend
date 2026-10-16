#!/usr/bin/env node
/**
 * Lighthouse perf capture for PE Watch (Step 37 #11 / Boss Plan §1.4).
 *
 * Runs a Lighthouse performance audit against a rendered PE Watch page (with a
 * real PE that has a populated Program Team panel) and reports the key Core Web
 * Vitals — First Contentful Paint (FCP) and Largest Contentful Paint (LCP) —
 * checking them against a budget. Exits non-zero if the budget is exceeded so
 * it can gate CI / the acceptance run.
 *
 * Usage:
 *   PE_WATCH_URL="https://app.capiro.ai/program-elements/0603270A" \
 *   LH_AUTH_COOKIE="__session=..." \
 *     pnpm --filter @capiro/web lighthouse:pe-watch
 *
 * Budgets (override via env): LH_FCP_BUDGET_MS (default 2000),
 *   LH_LCP_BUDGET_MS (default 2500), LH_PERF_MIN (default 0.80).
 *
 * Requires Chrome/Chromium available to chrome-launcher. In CI, run after
 * `vite build` + `vite preview` (or against a deployed/staging URL).
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */

const USAGE = 'Usage: PE_WATCH_URL=<url> node apps/web/scripts/lighthouse-pe-watch.mjs --run';
const cliArgs = process.argv.slice(2);
if (cliArgs.length === 1 && (cliArgs[0] === '--help' || cliArgs[0] === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (cliArgs.length !== 1 || cliArgs[0] !== '--run') {
  console.error(USAGE);
  if (cliArgs.length) console.error(`[lighthouse-pe-watch] unknown argument: ${cliArgs.join(' ')}`);
  process.exit(2);
}
if (!process.env.PE_WATCH_URL?.trim()) {
  console.error(USAGE);
  process.exit(2);
}

const URL = process.env.PE_WATCH_URL;
const FCP_BUDGET = Number(process.env.LH_FCP_BUDGET_MS ?? 2000);
const LCP_BUDGET = Number(process.env.LH_LCP_BUDGET_MS ?? 2500);
const PERF_MIN = Number(process.env.LH_PERF_MIN ?? 0.8);
const AUTH_COOKIE = process.env.LH_AUTH_COOKIE;

async function main() {
  const [{ default: lighthouse }, chromeLauncher] = await Promise.all([
    import('lighthouse'), import('chrome-launcher'),
  ]);
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  });
  try {
    const extraHeaders = AUTH_COOKIE ? { Cookie: AUTH_COOKIE } : undefined;
    const result = await lighthouse(
      URL,
      {
        port: chrome.port,
        onlyCategories: ['performance'],
        formFactor: 'desktop',
        screenEmulation: { mobile: false, disabled: false, width: 1440, height: 900, deviceScaleFactor: 1 },
        extraHeaders,
      },
    );

    if (!result || !result.lhr) {
      console.error('Lighthouse returned no result.');
      process.exit(1);
    }

    const lhr = result.lhr;
    const perfScore = (lhr.categories.performance?.score ?? 0) * 100;
    const fcp = lhr.audits['first-contentful-paint']?.numericValue ?? NaN;
    const lcp = lhr.audits['largest-contentful-paint']?.numericValue ?? NaN;
    const tbt = lhr.audits['total-blocking-time']?.numericValue ?? NaN;
    const cls = lhr.audits['cumulative-layout-shift']?.numericValue ?? NaN;

    const round = (v) => (Number.isFinite(v) ? Math.round(v) : 'n/a');
    console.log('=== PE Watch Lighthouse (performance) ===');
    console.log(`URL:               ${URL}`);
    console.log(`Performance score: ${perfScore.toFixed(0)} (budget >= ${(PERF_MIN * 100).toFixed(0)})`);
    console.log(`FCP:               ${round(fcp)} ms (budget <= ${FCP_BUDGET})`);
    console.log(`LCP:               ${round(lcp)} ms (budget <= ${LCP_BUDGET})`);
    console.log(`TBT:               ${round(tbt)} ms`);
    console.log(`CLS:               ${Number.isFinite(cls) ? cls.toFixed(3) : 'n/a'}`);

    const failures = [];
    if (Number.isFinite(fcp) && fcp > FCP_BUDGET) failures.push(`FCP ${round(fcp)}ms > ${FCP_BUDGET}ms`);
    if (Number.isFinite(lcp) && lcp > LCP_BUDGET) failures.push(`LCP ${round(lcp)}ms > ${LCP_BUDGET}ms`);
    if (perfScore / 100 < PERF_MIN) failures.push(`perf ${perfScore.toFixed(0)} < ${(PERF_MIN * 100).toFixed(0)}`);

    if (failures.length > 0) {
      console.error(`\nBUDGET EXCEEDED: ${failures.join('; ')}`);
      process.exit(1);
    }
    console.log('\nBudget met. ✅');
  } finally {
    await chrome.kill();
  }
}

main().catch((err) => {
  console.error('Lighthouse run failed:', err);
  process.exit(1);
});
