#!/usr/bin/env node
/**
 * STRICT per-route content observation (DEVELOPMENT ONLY — never a baseline).
 *
 * Visits every captured route with the fixture API in STRICT mode (no permissive
 * flag), confines the page to the exact owned origin, and records for each route
 * the endpoints it ACTUALLY consumed (seeded), its visible headings and body
 * text — but ONLY for routes that rendered with zero fixture gaps and zero page
 * errors. A route that did not render cleanly is recorded as `unclean` and is
 * deliberately NOT pinned, so a loading/blank/error shell can never become a
 * sentinel. Output feeds scripts/gen-route-sentinels.mjs.
 *
 *   node scripts/discover-route-content.mjs --discover
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: discover-route-content.mjs --discover (writes route-content-observed.json and route-content-unclean.json)';
const cliArgs = process.argv.slice(2);
if (cliArgs.length === 1 && (cliArgs[0] === '--help' || cliArgs[0] === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (cliArgs.length !== 1 || cliArgs[0] !== '--discover') {
  console.error(USAGE);
  if (cliArgs.length) console.error(`[discovery] unknown argument: ${cliArgs.join(' ')}`);
  process.exit(2);
}

const { chromium } = await import('../lib/playwright-bridge.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = process.env.CAPIRO_VISUAL_BASE_URL || 'http://127.0.0.1:4190';
const OWNED = new URL(BASE).origin;
const FIXED = new Date('2026-10-07T12:00:00.000Z');

const inventory = JSON.parse(readFileSync(path.join(ROOT, 'routes.inventory.json'), 'utf8'));
const routes = inventory.routes.filter((r) => r.coverage === 'captured');

const KILL_MOTION = `(() => { const a=()=>{const r=document.head||document.documentElement;if(!r)return;const s=document.createElement('style');s.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';r.appendChild(s);};a();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',a,{once:true});})();`;

const browser = await chromium.launch({ headless: true, args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--proxy-server=direct://', '--proxy-bypass-list=*'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'America/New_York', reducedMotion: 'reduce', serviceWorkers: 'block' });

const observed = {};
const unclean = [];

for (const route of routes) {
  const page = await ctx.newPage();
  await page.addInitScript(KILL_MOTION);
  await page.route('**/*', async (r) => {
    let u;
    try { u = new URL(r.request().url()); } catch { return r.abort('blockedbyclient'); }
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return r.continue();
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === OWNED) return r.continue();
    return r.abort('blockedbyclient');
  });
  await page.routeWebSocket(/.*/, (ws) => { try { const u = new URL(ws.url()); if (u.protocol === 'ws:' && `${u.protocol}//${u.host}` === `ws://${new URL(BASE).host}`) return ws.connectToServer(); } catch { /* deny */ } ws.close({ code: 1008 }); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.clock.setFixedTime(FIXED);
  let probe;
  try {
    await page.goto(BASE + route.path, { waitUntil: 'load', timeout: 45000 });
    await page.waitForSelector('.capiro-vnext-root', { timeout: 45000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
    probe = await page.evaluate(() => {
      const w = window;
      const txt = (document.body?.innerText || '');
      return {
        landed: location.pathname + location.search,
        headings: Array.from(document.querySelectorAll('h1,h2,h3,[role=heading]')).map((h) => (h.textContent || '').trim()).slice(0, 8),
        bodyText: txt.replace(/\s+/g, ' ').trim().slice(0, 400),
        bodyLen: txt.trim().length,
        seeded: (w.__VISUAL_FIXTURE_SEEDED__ || []).slice(-80),
        hits: (w.__VISUAL_FIXTURE_HITS__ || []).slice(-80),
        gaps: (w.__VISUAL_FIXTURE_GAPS__ || []).slice(-12),
      };
    });
  } catch (e) {
    errors.push('nav: ' + e.message.slice(0, 160));
    probe = null;
  }
  await page.close();

  const samePath = (a, b) => {
    const po = (s) => (s.split('?')[0] || '/').replace(/\/$/, '') || '/';
    return Boolean(a) && po(a) === po(b);
  };
  if (probe && probe.gaps.length === 0 && errors.length === 0 && samePath(probe.landed, route.path) && probe.bodyLen > 0) {
    observed[route.path] = { seeded: probe.seeded, headings: probe.headings, bodyText: probe.bodyText, bodyLen: probe.bodyLen };
    console.log(`OK   ${route.path}  own=${probe.seeded.length} headings=${probe.headings.length} body=${probe.bodyLen}`);
  } else {
    unclean.push({ route: route.path, landed: probe?.landed ?? null, gaps: probe?.gaps?.length ?? null, gapUrls: probe?.gaps ?? [], hits: probe?.hits ?? [], errors, bodyLen: probe?.bodyLen ?? 0 });
    console.log(`DIRTY ${route.path}  landed=${probe?.landed ?? '?'} gaps=${probe?.gaps?.length ?? '?'} err=${errors.length} body=${probe?.bodyLen ?? 0}`);
  }
}

await browser.close();
writeFileSync(path.join(ROOT, 'route-content-observed.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), strict: true, routes: observed }, null, 2)}\n`);
writeFileSync(path.join(ROOT, 'route-content-unclean.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), routes: unclean }, null, 2)}\n`);
console.log(`\n[discovery] clean=${Object.keys(observed).length} unclean=${unclean.length} of ${routes.length}`);
