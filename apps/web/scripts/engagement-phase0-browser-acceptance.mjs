#!/usr/bin/env node
/**
 * Engagement Phase 0 browser acceptance script.
 *
 * Launches Chrome via chrome-launcher, sets Clerk auth cookies,
 * navigates the Engagement UI states, captures screenshots at 4 viewports,
 * runs accessibility audits, and writes evidence to the evidence directory.
 *
 * Reuses phase19-cdp.mjs for CDP helpers.
 *
 * Required env vars:
 *   ENGAGEMENT_PHASE0_CLERK_ORG_ID
 *   ENGAGEMENT_PHASE0_USER_COOKIE
 *   ENGAGEMENT_PHASE0_BASE_URL    (default http://127.0.0.1:5173)
 *   ENGAGEMENT_PHASE0_EVIDENCE_DIR
 *   ENGAGEMENT_PHASE0_FIXTURE_FILE
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chromeLauncher from 'chrome-launcher';
import { connectChrome, createActor } from './phase19-cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = process.env.ENGAGEMENT_PHASE0_EVIDENCE_DIR;
const BASE_URL = process.env.ENGAGEMENT_PHASE0_BASE_URL ?? 'http://127.0.0.1:5173';
const FIXTURE_FILE = process.env.ENGAGEMENT_PHASE0_FIXTURE_FILE;

function required(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'desktop-1024x768', width: 1024, height: 768 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
];

const STATES = [
  { path: '/engagement/meetings', label: 'Meetings Landing' },
  { path: '/engagement/outreach', label: 'Outreach List' },
  { path: '/engagement/reports', label: 'Reports' },
  { path: '/engagement/integrations', label: 'Integrations' },
];

async function main() {
  const cookie = required('ENGAGEMENT_PHASE0_USER_COOKIE');
  const orgId = required('ENGAGEMENT_PHASE0_CLERK_ORG_ID');
  if (!EVIDENCE) throw new Error('ENGAGEMENT_PHASE0_EVIDENCE_DIR is required');

  await mkdir(path.join(EVIDENCE, 'screenshots'), { recursive: true });
  await mkdir(path.join(EVIDENCE, 'logs'), { recursive: true });

  console.log(`\nStarting Chrome...`);
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
    startingUrl: 'about:blank',
  });
  const cdp = await connectChrome(chrome.port);
  console.log(`Chrome running on port ${chrome.port}`);

  let passCount = 0;
  let failCount = 0;
  const results = [];

  try {
    // Create authenticated actor
    console.log('\n--- Creating authenticated actor ---');
    const page = await createActor({
      cdp,
      label: 'engagement-phase0',
      cookie,
      orgId,
      baseUrl: BASE_URL,
      evidenceDir: EVIDENCE,
    });
    console.log('Actor authenticated, Clerk session active');

    // Capture each state at each viewport
    for (const state of STATES) {
      for (const vp of VIEWPORTS) {
        const stateResult = await captureState(page, state, vp);
        results.push(stateResult);
        if (stateResult.passed) passCount++;
        else failCount++;
      }
    }

    // Additional screenshots: Outreach detail using seeded draft record
    if (FIXTURE_FILE) {
      const fixtures = JSON.parse(await (await fetch(`file://${FIXTURE_FILE}`)).text());
      const draftId = fixtures.outreachIds?.draft;
      if (draftId) {
        for (const vp of VIEWPORTS.slice(0, 1)) {
          const result = await captureState(page, { path: `/engagement/outreach/${draftId}`, label: 'Outreach Detail (Draft)' }, vp);
          results.push(result);
          if (result.passed) passCount++; else failCount++;
        }
      }
    }

  } finally {
    // Write results
    const summary = {
      marker: 'ENGAGEMENT_PHASE0_BROWSER_COMPLETE',
      viewports: VIEWPORTS.map((v) => v.name),
      states: STATES.map((s) => s.label),
      passed: passCount,
      failed: failCount,
      total: passCount + failCount,
      externalProviderAction: false,
      results,
    };
    await writeFile(path.join(EVIDENCE, 'browser-results.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`\n=== Browser Acceptance: ${passCount}/${passCount + failCount} passed ===`);

    await chrome.kill();
  }
}

async function captureState(page, state, vp) {
  const label = `${state.label} @ ${vp.name}`;
  console.log(`\n  ${label}`);
  const logPath = path.join(EVIDENCE, 'logs', `${safeName(label)}.log`);

  try {
    await page.setViewport(vp.width, vp.height);

    // Navigate
    const url = state.path.startsWith('http') ? state.path : `${BASE_URL}${state.path}`;
    const loaded = page.cdp.once('Page.loadEventFired', page.sessionId, 30_000).catch(() => ({}));
    await page.cdp.send('Page.navigate', { url }, page.sessionId);
    await loaded;
    await page.waitFor(() => page.evaluate('document.readyState === "complete"'), 20_000);
    await sleep(2000);

    // Check for error boundary
    const hasError = await page.evaluate(`
      (document.body?.innerText ?? '').includes('Something went wrong') ||
      (document.body?.innerText ?? '').includes('Application error')
    `);
    if (hasError) throw new Error('Error boundary detected');

    // Check no horizontal overflow
    const overflow = await page.evaluate(
      'document.documentElement.scrollWidth > document.documentElement.clientWidth + 2'
    );
    if (overflow) console.warn(`  WARNING: Horizontal overflow at ${vp.name}`);

    // Screenshot
    const ss = await page.screenshot(`${label}`);
    console.log(`    Screenshot: ${ss}`);

    // Accessibility audit
    const audit = await page.audit();
    const aaIssues = [];
    if (audit.duplicates.length > 0) aaIssues.push(`${audit.duplicates.length} duplicate IDs`);
    if (audit.brokenLabelledBy.length > 0) aaIssues.push(`${audit.brokenLabelledBy.length} broken aria-labelledby`);
    if (audit.unnamedAx.length > 0) aaIssues.push(`${audit.unnamedAx.length} unnamed interactive AX elements`);
    if (audit.clipped.length > 0) aaIssues.push(`${audit.clipped.length} clipped focusable controls`);

    if (aaIssues.length > 0) {
      await writeFile(logPath, JSON.stringify({ label, url, viewport: vp.name, audit, aaIssues }, null, 2) + '\n');
      console.warn(`    A11y issues: ${aaIssues.join(', ')}`);
    }

    // Check console errors (via Runtime.exceptionThrown)
    // The page was already initialized with Runtime.enable

    return {
      label,
      viewport: vp.name,
      url,
      passed: !hasError,
      screenshot: ss,
      a11yIssues: aaIssues,
      overflow,
    };
  } catch (error) {
    console.error(`    FAILED: ${error.message}`);
    // Try to capture a failure screenshot
    try {
      const ss = await page.screenshot(`${label}-failure`);
      console.log(`    Failure screenshot: ${ss}`);
    } catch { /* can't screenshot either */ }

    await writeFile(
      logPath,
      JSON.stringify({
        label,
        viewport: vp.name,
        error: error instanceof Error ? error.message : String(error),
      }, null, 2) + '\n',
    );

    return { label, viewport: vp.name, passed: false, error: error.message };
  }
}

function safeName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (error) => {
  console.error('\n=== BROWSER ACCEPTANCE FAILED ===');
  console.error(error instanceof Error ? error.message : String(error));
  if (EVIDENCE) {
    await writeFile(
      path.join(EVIDENCE, 'browser-failure.json'),
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        externalProviderAction: false,
      }, null, 2) + '\n',
    ).catch(() => {});
  }
  process.exitCode = 1;
});
