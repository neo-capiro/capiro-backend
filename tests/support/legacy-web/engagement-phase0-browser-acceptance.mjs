#!/usr/bin/env node
/**
 * Engagement Phase 0 browser acceptance script.
 *
 * Launches Chrome via chrome-launcher, sets Clerk auth cookies,
 * navigates the Engagement UI states, captures screenshots at 4 viewports,
 * runs accessibility audits, and writes evidence to the evidence directory.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const chromeLauncher = require('chrome-launcher');
import { connectChrome, createActor } from './phase19-cdp.mjs';

const EVIDENCE = process.env.ENGAGEMENT_PHASE0_EVIDENCE_DIR;
const BASE_URL = process.env.ENGAGEMENT_PHASE0_BASE_URL ?? 'http://127.0.0.1:5173';
const FIXTURE_FILE = process.env.ENGAGEMENT_PHASE0_FIXTURE_FILE;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function maybeMintClerkTicket() {
  const secret = process.env.CLERK_SECRET_KEY?.trim();
  const userId = (
    process.env.ENGAGEMENT_PHASE1_USER_CLERK_ID ||
    process.env.ENGAGEMENT_PHASE0_USER_CLERK_ID ||
    ''
  ).trim();
  if (!secret || !userId) return '';
  const response = await fetch('https://api.clerk.com/v1/sign_in_tokens', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 1800 }),
  });
  const body = await response.json();
  if (!response.ok || !body?.token) {
    throw new Error(`Clerk sign_in_token mint failed status=${response.status}`);
  }
  return body.token;
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
  const orgId = required(process.env.ENGAGEMENT_PHASE1_CLERK_ORG_ID ? 'ENGAGEMENT_PHASE1_CLERK_ORG_ID' : 'ENGAGEMENT_PHASE0_CLERK_ORG_ID');
  const cookie = (process.env.ENGAGEMENT_PHASE1_USER_COOKIE || process.env.ENGAGEMENT_PHASE0_USER_COOKIE || '').trim();
  const clerkTicket = await maybeMintClerkTicket();
  if (!EVIDENCE) throw new Error('ENGAGEMENT_PHASE0_EVIDENCE_DIR is required');

  await mkdir(path.join(EVIDENCE, 'screenshots'), { recursive: true });
  await mkdir(path.join(EVIDENCE, 'logs'), { recursive: true });

  console.log('\nStarting Chrome...');
  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1440,900',
    ],
    startingUrl: 'about:blank',
  });
  const cdp = await connectChrome(chrome.port);
  console.log(`Chrome running on port ${chrome.port}`);

  let passCount = 0;
  let failCount = 0;
  const results = [];

  try {
    console.log('\n--- Creating authenticated actor ---');
    if (!cookie && !clerkTicket) {
      throw new Error('USER_COOKIE or CLERK_SECRET_KEY+user id required for browser auth');
    }
    const page = await createActor({
      cdp,
      label: '',
      cookie,
      clerkTicket,
      orgId,
      baseUrl: BASE_URL,
      evidenceDir: EVIDENCE,
    });
    console.log('Actor authenticated, Clerk session active');

    for (const state of STATES) {
      for (const viewport of VIEWPORTS) {
        const stateResult = await captureState(page, state, viewport);
        results.push(stateResult);
        if (stateResult.passed) passCount += 1;
        else failCount += 1;
      }
    }

    if (FIXTURE_FILE) {
      const fixtures = JSON.parse(await readFile(FIXTURE_FILE, 'utf8'));
      const draftId = fixtures.outreachIds?.draft;
      if (draftId) {
        const result = await captureState(
          page,
          {
            path: `/engagement/outreach/${draftId}`,
            label: 'Outreach Detail (Draft)',
          },
          VIEWPORTS[0],
        );
        results.push(result);
        if (result.passed) passCount += 1;
        else failCount += 1;
      }
    }
  } finally {
    const summary = {
      marker:
        failCount === 0
          ? 'ENGAGEMENT_PHASE0_BROWSER_COMPLETE'
          : 'ENGAGEMENT_PHASE0_BROWSER_FAILED',
      viewports: VIEWPORTS.map((viewport) => viewport.name),
      states: STATES.map((state) => state.label),
      passed: passCount,
      failed: failCount,
      total: passCount + failCount,
      externalProviderAction: false,
      results,
    };
    await writeFile(
      path.join(EVIDENCE, 'browser-results.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(`\n=== Browser Acceptance: ${passCount}/${passCount + failCount} passed ===`);
    await chrome.kill();
    if (failCount > 0) {
      throw new Error(`${failCount} Engagement browser state(s) failed`);
    }
  }
}

async function captureState(page, state, viewport) {
  const label = `${state.label} @ ${viewport.name}`;
  console.log(`\n  ${label}`);
  const logPath = path.join(EVIDENCE, 'logs', `${safeName(label)}.log`);

  try {
    await page.setViewport(viewport.width, viewport.height);
    const url = state.path.startsWith('http') ? state.path : `${BASE_URL}${state.path}`;
    const loaded = page.cdp
      .once('Page.loadEventFired', page.sessionId, 30_000)
      .catch(() => ({}));
    await page.cdp.send('Page.navigate', { url }, page.sessionId);
    await loaded;
    await page.waitFor(
      () => page.evaluate('document.readyState === "complete"'),
      20_000,
    );
    await sleep(2_000);

    const hasError = await page.evaluate(`
      (document.body?.innerText ?? '').includes('Something went wrong') ||
      (document.body?.innerText ?? '').includes('Application error')
    `);
    if (hasError) throw new Error('Error boundary detected');

    const overflow = await page.evaluate(
      'document.documentElement.scrollWidth > document.documentElement.clientWidth + 2',
    );
    if (overflow) console.warn(`  WARNING: Horizontal overflow at ${viewport.name}`);

    const screenshot = await page.screenshot(label);
    console.log(`    Screenshot: ${screenshot}`);

    const audit = await page.audit();
    const accessibilityIssues = [];
    if (audit.duplicates.length > 0) {
      accessibilityIssues.push(`${audit.duplicates.length} duplicate IDs`);
    }
    if (audit.brokenLabelledBy.length > 0) {
      accessibilityIssues.push(`${audit.brokenLabelledBy.length} broken aria-labelledby`);
    }
    if (audit.unnamedAx.length > 0) {
      accessibilityIssues.push(`${audit.unnamedAx.length} unnamed interactive AX elements`);
    }
    if (audit.clipped.length > 0) {
      accessibilityIssues.push(`${audit.clipped.length} clipped focusable controls`);
    }

    if (accessibilityIssues.length > 0) {
      await writeFile(
        logPath,
        `${JSON.stringify(
          { label, url, viewport: viewport.name, audit, accessibilityIssues },
          null,
          2,
        )}\n`,
      );
      console.warn(`    A11y issues: ${accessibilityIssues.join(', ')}`);
    }

    return {
      label,
      viewport: viewport.name,
      url,
      passed: true,
      screenshot,
      accessibilityIssues,
      overflow,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`    FAILED: ${message}`);
    try {
      const screenshot = await page.screenshot(`${label}-failure`);
      console.log(`    Failure screenshot: ${screenshot}`);
    } catch {
      // Preserve the primary failure.
    }

    await writeFile(
      logPath,
      `${JSON.stringify(
        { label, viewport: viewport.name, error: message },
        null,
        2,
      )}\n`,
    );
    return { label, viewport: viewport.name, passed: false, error: message };
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
  const message = error instanceof Error ? error.message : String(error);
  console.error('\n=== BROWSER ACCEPTANCE FAILED ===');
  console.error(message);
  if (EVIDENCE) {
    await writeFile(
      path.join(EVIDENCE, 'browser-failure.json'),
      `${JSON.stringify({ error: message, externalProviderAction: false }, null, 2)}\n`,
    ).catch(() => undefined);
  }
  process.exitCode = 1;
});
