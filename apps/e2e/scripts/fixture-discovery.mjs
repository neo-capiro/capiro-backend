#!/usr/bin/env node
/**
 * Fixture discovery (DEVELOPMENT ONLY — never a baseline run).
 *
 * Visits every captured route with the fixture API in explicit PERMISSIVE mode
 * (unseeded reads return an empty collection and are recorded) so the FULL set of
 * endpoints each route reaches can be enumerated. Also records requests that no
 * client could serve (blocked / dev-server 404) and page errors. Output feeds the
 * explicit fixtures in routes-visual-api.ts. A strict baseline run rejects all of
 * these.
 *
 *   node scripts/fixture-discovery.mjs [--project=desktop-1440]
 */
import { chromium } from '../lib/playwright-bridge.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = 'http://127.0.0.1:4190';
const inventory = JSON.parse(readFileSync(path.join(ROOT, 'routes.inventory.json'), 'utf8'));
const routes = inventory.routes.filter((r) => r.coverage === 'captured');

const FREEZE = `(() => { const f = Date.parse('2026-10-07T12:00:00.000Z'); const R = Date; class D extends R { constructor(...a){ if(!a.length){super(f)}else{super(...a)} } static now(){return f} } Object.defineProperty(window,'Date',{value:D,configurable:true}); })();`;
const PERMISSIVE = `window.__VISUAL_FIXTURE_PERMISSIVE__ = true;`;
const LOCALS = /^(http:\/\/127\.0\.0\.1|http:\/\/localhost|data:|blob:|about:)/;

const browser = await chromium.launch({ headless: true, args: ['--hide-scrollbars', '--proxy-server=direct://', '--proxy-bypass-list=*'] });
const results = [];

for (const route of routes) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'America/New_York', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.addInitScript(FREEZE);
  await page.addInitScript(PERMISSIVE);
  const blocked = [];
  await page.route('**', async (r) => {
    const u = r.request().url();
    if (LOCALS.test(u)) {
      // dev-server API paths that aren't really served (relative /api calls that
      // bypass the use-api alias) surface as a 404 document — record them.
      if (/\/api\/|api\//.test(u) && !/\/@|\.tsx?($|\?)|\.js($|\?)|\.css/.test(u)) blocked.push(u.replace(BASE, ''));
      await r.continue();
    } else {
      blocked.push('EXTERNAL ' + u.slice(0, 120));
      await r.abort('blockedbyclient');
    }
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  try {
    await page.goto(BASE + route.path, { waitUntil: 'load', timeout: 45000 });
    await page.waitForFunction(() => Boolean(document.querySelector('.capiro-vnext-root')), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  } catch (e) {
    errors.push('nav: ' + e.message.slice(0, 120));
  }
  const probe = await page.evaluate(() => ({
    landed: location.pathname + location.search,
    headings: Array.from(document.querySelectorAll('h1,h2,h3')).map((h) => (h.textContent || '').trim()).slice(0, 6),
    bodyLen: (document.body?.innerText || '').trim().length,
    gaps: (window.__VISUAL_FIXTURE_GAPS__ || []).map((g) => `${g.method.toUpperCase()} ${g.url}`),
  })).catch(() => ({ gaps: [], headings: [], bodyLen: 0, landed: '' }));
  results.push({ route: route.path, landed: probe.landed, headings: probe.headings, bodyLen: probe.bodyLen, gaps: [...new Set(probe.gaps)], blocked: [...new Set(blocked)], errors: [...new Set(errors)].slice(0, 4) });
  const g = probe.gaps.length + blocked.length;
  console.log(`${g === 0 && errors.length === 0 ? 'OK  ' : 'GAP '} ${route.path}  gaps=${probe.gaps.length} blocked=${blocked.length} err=${errors.length} body=${probe.bodyLen}`);
  await ctx.close();
}

await browser.close();
mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
writeFileSync(path.join(ROOT, 'reports', 'fixture-discovery.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), routes: results }, null, 2)}\n`);

// aggregate endpoints
const endpoints = new Map();
for (const r of results) for (const g of r.gaps) endpoints.set(g, (endpoints.get(g) || []).concat(r.route));
console.log('\n=== UNIQUE UNSEEDED ENDPOINTS ===');
for (const [ep, rs] of [...endpoints.entries()].sort()) console.log(`  ${ep}   <- ${rs.length} route(s)`);
console.log(`\nroutes with gaps: ${results.filter((r) => r.gaps.length || r.blocked.length).length}/${results.length}`);
