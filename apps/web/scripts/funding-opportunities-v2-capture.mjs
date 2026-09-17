import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/dev/node_modules/playwright');
import fs from 'node:fs/promises';
const base = process.env.FO_BASE_URL || 'http://127.0.0.1:5186/funding-opportunities-v2-preview.html?client=overland&mode=matched&query=autonomous%20ground%20vehicle%20sustainment&type=grant,solicitation&sector=defense%20electronics,autonomous%20systems,logistics&deadlineWindow=90d&naics=541715&eligibility=eligible&lifecycle=active,forecast';
const out = 'C:/dev/main/.orchestration/funding-opportunities-v2/preview-artifacts';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const capture = async (page, name) => {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: !name.includes('-filters-') && !name.includes('-health-') && !name.includes('-client-') && !name.includes('-sentence-edit-') });
  const metrics = await page.evaluate(() => { const q = (s) => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null; return { viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, bodyHeight: document.body.scrollHeight, shellTopbar: q('.uui-topbar'), shellRail: q('.uui-rail'), header: q('.fo-v2-header'), builder: q('.fo-v2-builder'), toolbar: q('.fo-v2-toolbar'), firstCard: q('.fo-v2-card'), h1: document.querySelector('.fo-v2-title h1')?.textContent, rowCount: document.querySelectorAll('.fo-v2-card').length, visibleDialog: document.querySelector('[role="dialog"]')?.getAttribute('aria-label') ?? null, errors: [] }; });
  return metrics;
};
for (const [width, height] of [[1440, 1000], [1024, 768], [768, 768]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 });
  try { await page.waitForSelector('[data-testid="fo-v2"]', { timeout: 12000 }); }
  catch (error) {
    const body = await page.locator('body').innerText().catch(() => '');
    await fs.writeFile(`${out}/failure-${width}x${height}.json`, JSON.stringify({ message: String(error), body, errors }, null, 2));
    throw error;
  }
  const metrics = await capture(page, `preview-${width}x${height}`);
  metrics.errors = errors; await fs.writeFile(`${out}/preview-${width}x${height}.json`, JSON.stringify(metrics, null, 2)); await page.close();
}
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 }); await page.waitForSelector('[data-testid="fo-v2"]', { timeout: 12000 });
for (const [label, trigger] of [
  ['filters', 'Filters'], ['health', 'Source health'], ['client', 'Overland AI'], ['sentence-edit', 'active'],
]) {
  if (label === 'client') {
    await page.getByRole('button', { name: 'Overland AI', exact: true }).first().click();
  } else if (label === 'sentence-edit') {
    await page.keyboard.press('Escape');
    if (await page.locator('.fo-v2-editor-strip').count()) await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    await page.getByRole('button', { name: 'active +1', exact: true }).first().click();
  } else {
    await page.getByRole('button', { name: trigger, exact: label === 'client' }).first().click();
  }
  await page.waitForSelector('[role="dialog"], [data-fo-overlay="true"]', { timeout: 3000 });
  const metrics = await capture(page, `preview-${label}-1440x1000`); metrics.errors = [...errors];
  await fs.writeFile(`${out}/preview-${label}-1440x1000.json`, JSON.stringify(metrics, null, 2));
  await page.keyboard.press('Escape'); await page.waitForTimeout(50);
}
await page.close();
await browser.close(); console.log(`ARTIFACTS=${out}`);
