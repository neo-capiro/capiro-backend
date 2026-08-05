#!/usr/bin/env node
/**
 * Clerk-free browser network proof for Phase 1.
 * Opens Engagement routes and records that browser traffic targets the main
 * API (:4000) and never the shadow service (:4500).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.join(process.cwd(), 'apps/web/package.json'));
const chromeLauncher = require('chrome-launcher');
const { connectChrome } = await import(
  pathToFileURL(path.join(process.cwd(), 'apps/web/scripts/phase19-cdp.mjs')).href
);

const BASE_URL = process.env.ENGAGEMENT_PHASE1_BASE_URL ?? 'http://127.0.0.1:5173';
const EVIDENCE = process.env.ENGAGEMENT_PHASE1_EVIDENCE_DIR;
const MAIN = process.env.ENGAGEMENT_PHASE1_MAIN_URL ?? 'http://127.0.0.1:4000';
const SHADOW = process.env.ENGAGEMENT_PHASE1_ENGAGEMENT_URL ?? 'http://127.0.0.1:4500';
if (!EVIDENCE) throw new Error('ENGAGEMENT_PHASE1_EVIDENCE_DIR required');

const ROUTES = [
  '/engagement/meetings',
  '/engagement/outreach',
  '/engagement/reports',
  '/engagement/integrations',
];

const chrome = await chromeLauncher.launch({
  chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  startingUrl: 'about:blank',
});

const requests = [];
try {
  const cdp = await connectChrome(chrome.port);
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const sid = attached.sessionId;
  for (const d of ['Page', 'Network', 'Runtime']) {
    await cdp.send(`${d}.enable`, {}, sid);
  }
  const key = `${sid}:Network.requestWillBeSent`;
  const listener = (params) => {
    const req = params?.request ?? {};
    requests.push({
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers ?? {}).filter(([h]) => !/authorization|cookie/i.test(h)),
      ),
    });
  };
  cdp.listeners.set(key, [...(cdp.listeners.get(key) ?? []), listener]);

  await mkdir(path.join(EVIDENCE, 'screenshots'), { recursive: true });
  for (const route of ROUTES) {
    await cdp.send('Page.navigate', { url: `${BASE_URL}${route}` }, sid);
    await new Promise((r) => setTimeout(r, 2500));
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
    const name = route.replace(/\//g, '_').replace(/^_/, '') || 'root';
    await writeFile(
      path.join(EVIDENCE, 'screenshots', `network-${name}.png`),
      Buffer.from(png.data, 'base64'),
    );
  }

  const mainHost = new URL(MAIN).host;
  const shadowHost = new URL(SHADOW).host;
  const shadowHits = requests.filter(
    (r) =>
      String(r.url).includes(':4500') ||
      String(r.url).includes(shadowHost) ||
      /engagement-api/i.test(String(r.url)),
  );
  const mainHits = requests.filter(
    (r) => String(r.url).includes(':4000') || String(r.url).includes(mainHost),
  );
  const viteHits = requests.filter((r) => String(r.url).includes(':5173'));

  if (shadowHits.length > 0) {
    throw new Error(`Browser issued ${shadowHits.length} request(s) to shadow :4500`);
  }

  const network = {
    marker: 'ENGAGEMENT_PHASE1_BROWSER_NETWORK_OK',
    mode: 'clerk_skipped_network_proof',
    routes: ROUTES,
    totalRequests: requests.length,
    mainApiHits: mainHits.length,
    viteHits: viteHits.length,
    shadowHits: 0,
    sampleMain: mainHits.slice(0, 5).map((r) => r.url),
    noPort4500: true,
    noEngagementApiHost: true,
  };
  const browser = {
    marker: 'ENGAGEMENT_PHASE1_BROWSER_NETWORK_PROOF',
    mode: 'clerk_skipped',
    passed: true,
    failed: 0,
    routes: ROUTES,
    externalProviderAction: false,
  };
  await writeFile(path.join(EVIDENCE, 'browser-network-proof.json'), `${JSON.stringify(network, null, 2)}\n`);
  await writeFile(path.join(EVIDENCE, 'browser-results.json'), `${JSON.stringify(browser, null, 2)}\n`);
  console.log(JSON.stringify(network));
} finally {
  try {
    const r = chrome.kill();
    if (r && typeof r.then === 'function') await r;
  } catch {
    /* ignore */
  }
}
