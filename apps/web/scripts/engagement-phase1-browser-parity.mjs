#!/usr/bin/env node
/**
 * Authenticated Chrome/CDP proof that the unchanged web application still uses
 * only the main API during Phase 1. Missing credentials are a failure, not a
 * skip, because a skipped browser cannot authorize a merge.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const chromeLauncher = require('chrome-launcher');
import { connectChrome, createActor } from './phase19-cdp.mjs';

const BASE_URL = process.env.ENGAGEMENT_PHASE1_BASE_URL ?? 'http://127.0.0.1:5173';
const EVIDENCE = required('ENGAGEMENT_PHASE1_EVIDENCE_DIR');
const TOKEN_FILE = required('ENGAGEMENT_PHASE1_TOKEN_FILE');
const COOKIE = requiredAny('ENGAGEMENT_PHASE1_USER_COOKIE', 'ENGAGEMENT_PHASE0_USER_COOKIE');
const ORG_ID = requiredAny(
  'ENGAGEMENT_PHASE1_CLERK_ORG_ID',
  'ENGAGEMENT_PHASE0_CLERK_ORG_ID',
);
const SCREENSHOTS = path.join(EVIDENCE, 'screenshots');

const STATES = [
  '/engagement/meetings',
  '/engagement/outreach',
  '/engagement/reports',
  '/engagement/integrations',
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function requiredAny(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`One of ${names.join(', ')} is required`);
}

async function main() {
  await mkdir(SCREENSHOTS, { recursive: true });
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
  const requests = [];

  try {
    const page = await createActor({
      cdp,
      label: 'engagement-phase1',
      cookie: COOKIE,
      orgId: ORG_ID,
      baseUrl: BASE_URL,
      evidenceDir: SCREENSHOTS,
    });

    const networkKey = `${page.sessionId}:Network.requestWillBeSent`;
    const listener = (params) => {
      const request = params?.request ?? {};
      requests.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(
          Object.entries(request.headers ?? {}).filter(
            ([key]) => !/authorization|cookie/i.test(key),
          ),
        ),
      });
    };
    cdp.listeners.set(networkKey, [...(cdp.listeners.get(networkKey) ?? []), listener]);

    const bearerToken = await page.evaluate(`(async () => {
      const token = await window.Clerk?.session?.getToken({ template: 'capiro' });
      if (!token) throw new Error('Clerk capiro token unavailable');
      return token;
    })()`);
    if (typeof bearerToken !== 'string' || bearerToken.length < 20) {
      throw new Error('Authenticated browser did not produce a bearer token');
    }
    await writeFile(TOKEN_FILE, bearerToken, { mode: 0o600 });
    await chmod(TOKEN_FILE, 0o600).catch(() => undefined);

    const stateResults = [];
    for (const pathname of STATES) {
      await page.navigate(pathname);
      await page
        .waitFor(
          () => page.evaluate(`!((document.body?.innerText ?? '').includes('Loading'))`),
          30_000,
        )
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const body = await page.bodyText();
      const errorBoundary =
        body.includes('Something went wrong') || body.includes('Application error');
      if (errorBoundary) throw new Error(`Error boundary rendered at ${pathname}`);
      const screenshot = await page.screenshot(`phase1-${pathname}`);
      stateResults.push({ pathname, screenshot, errorBoundary: false });
    }

    const apiRequests = requests.filter((entry) => entry.url.includes('/api/engagement'));
    const port4500 = requests.filter((entry) => {
      try {
        return new URL(entry.url).port === '4500';
      } catch {
        return entry.url.includes(':4500');
      }
    });
    const previewHeaders = requests.filter((entry) =>
      Object.keys(entry.headers ?? {}).some(
        (key) => key.toLowerCase() === 'x-capiro-engagement-preview',
      ),
    );
    if (apiRequests.length === 0) {
      throw new Error('No authenticated Engagement API requests were observed');
    }
    if (port4500.length > 0) {
      throw new Error('The web application sent traffic to engagement-api port 4500');
    }
    if (previewHeaders.length > 0) {
      throw new Error('The web application sent the Phase 2 preview header');
    }

    const sourceChecks = [];
    for (const relative of ['apps/web/src/lib/api-client.ts', 'apps/web/src/lib/use-api.ts']) {
      const source = await readFile(path.resolve(process.cwd(), relative), 'utf8');
      for (const forbidden of [
        'VITE_ENGAGEMENT_API_URL',
        'X-Capiro-Engagement-Preview',
        ':4500',
      ]) {
        sourceChecks.push({ relative, forbidden, absent: !source.includes(forbidden) });
      }
    }
    if (sourceChecks.some((check) => !check.absent)) {
      throw new Error('Static web routing boundary contains a Phase 2 preview token');
    }

    const evidence = {
      marker: 'ENGAGEMENT_PHASE1_BROWSER_COMPLETE',
      baseUrl: BASE_URL,
      states: stateResults,
      observedRequestCount: requests.length,
      engagementApiRequestCount: apiRequests.length,
      engagementRequests: apiRequests,
      port4500Requests: port4500,
      previewHeaderRequests: previewHeaders,
      sourceChecks,
      currentOutreachRoute: '/engagement/outreach',
      previewRoutingEnabled: false,
    };
    await writeFile(
      path.join(EVIDENCE, 'browser-parity.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log('ENGAGEMENT_PHASE1_BROWSER_COMPLETE');
  } finally {
    await chrome.kill();
  }
}

main().catch(async (error) => {
  await mkdir(EVIDENCE, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(EVIDENCE, 'browser-parity-failure.json'),
    `${JSON.stringify(
      { error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    )}\n`,
  ).catch(() => undefined);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
