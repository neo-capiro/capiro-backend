import { chromium } from '../lib/playwright-bridge.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const t0 = Date.now();
const browser = await chromium.launch({ headless: true, args: ['--hide-scrollbars', '--proxy-server=direct://', '--proxy-bypass-list=*', '--force-device-scale-factor=1'] });
LOG('launched', Date.now() - t0);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'America/New_York', reducedMotion: 'reduce' });
const page = await ctx.newPage();
const LOCALS = /^(http:\/\/127\.0\.0\.1|http:\/\/localhost|data:|blob:|about:)/;
await page.route('**', async (r) => { if (LOCALS.test(r.request().url())) await r.continue(); else await r.abort('blockedbyclient'); });
page.on('pageerror', (e) => LOG('PAGEERROR', String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') LOG('CONSOLE-ERR', m.text().slice(0, 200)); });

LOG('goto');
await page.goto(process.argv[2] || '/help', { waitUntil: 'load', timeout: 60000 });
LOG('loaded');
await page.waitForFunction(() => Boolean(document.querySelector('.capiro-vnext-root')), null, { timeout: 45000 }).catch((e) => LOG('nolroot', e.message));
LOG('root present');
const probe = await page.evaluate(() => ({ landed: location.pathname + location.search, headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(h=>h.textContent.trim()), bodyLen: (document.body.innerText||'').length, gaps: (window.__VISUAL_FIXTURE_GAPS__||[]).slice(-5) }));
LOG('probe', JSON.stringify(probe).slice(0, 500));
LOG('fonts');
await page.evaluate(() => document.fonts.ready.then(() => undefined));
LOG('raf');
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
LOG('screenshot');
await page.screenshot({ path: path.join(HERE, '..', '.debug-shot.png') });
LOG('done', Date.now() - t0);
await browser.close();
